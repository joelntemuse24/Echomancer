"""
F5-TTS Server for Echomancer - Parallel Audiobook Pipeline

Architecture:
- fastapi_app           -> CPU-only web endpoint (instant cold start)
  - /generate_batch    -> Proxies to GPU container for voice preview
  - /generate_audiobook -> Spawns orchestrator, returns immediately
  - /health            -> Health check
- F5TTSServer           -> GPU container for voice preview (max_containers=1)
- F5TTSAudiobookWorker  -> GPU container for audiobook chunks (keep_warm=2, max_containers=4)
- process_audiobook     -> Orchestrator that splits work and uses .map()

The CPU endpoint means Vercel calls never time out on cold start.
"""

import os
import sys
import tempfile
import base64
import io
import time
import json
import subprocess
import shutil
import re
import traceback
import threading
from typing import List, Optional, Dict, Any
from dataclasses import dataclass, asdict
from contextlib import contextmanager

import modal

GPU_CONFIG = "A10G"

# Base image with ALL dependencies (used by both CPU and GPU functions)
# Note: Using run_commands with explicit UTF-8 encoding to avoid Windows codec issues
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg", "libsndfile1", "espeak-ng", "libespeak-ng1",
                 "libavcodec-dev", "libavformat-dev", "libavutil-dev",
                 "libswscale-dev", "libswresample-dev")
    .pip_install(
        "torch==2.5.1", "torchaudio==2.5.1",
        "transformers<4.49", "accelerate", "huggingface-hub",
        "soundfile", "librosa", "pydub",
        "numpy<2",
        "boto3", "httpx", "pymupdf",
        "faster-whisper", "num2words",
        "git+https://github.com/SWivid/F5-TTS.git",
    )
)

volume = modal.Volume.from_name("f5-tts-cache-v2", create_if_missing=True)

app = modal.App("echomancer-f5-tts", image=image)


# ── Constants ──────────────────────────────────────────────────────────────

# Paragraph and speed settings
MAX_PARAGRAPH_CHARS = 1500
BASE_SPEED = 0.88
MIN_SPEED = 0.75
MAX_SPEED = 1.0
DEFAULT_CFG_STRENGTH = 2.0
DIALOGUE_CFG_STRENGTH = 2.5

# Silence settings (in seconds)
PARAGRAPH_SILENCE = 0.5
CHAPTER_BREAK_SILENCE = 1.0


# ── Data Classes ──────────────────────────────────────────────────────────

@dataclass
class BatchTTSRequest:
    texts: List[str]
    reference_audio_base64: str
    reference_text: Optional[str] = None
    speed: float = BASE_SPEED  # 0.88 - slower, more natural pacing
    cfg_strength: float = 2.0
    nfe_step: int = 32


@dataclass
class ParagraphRequest:
    """Request for a single paragraph with analyzed parameters."""
    text: str
    speed: float
    cfg_strength: float
    ref_text: Optional[str] = None


@dataclass
class AudiobookRequest:
    job_id: str
    pdf_r2_key: str
    voice_r2_key: str
    start_time: float
    end_time: float
    webhook_url: str
    book_title: str = "Untitled"
    voice_name: str = "Unknown"
    r2_bucket_name: str = "echomancer-audio"
    pre_extracted_text: str = ""  # For non-PDF formats (EPUB, DOCX, TXT, etc.)


# ── Text Processing Helpers ────────────────────────────────────────────────

def normalize_punctuation(text: str) -> str:
    """
    Normalize punctuation to prevent shouting and improve cadence.
    - Multiple ! or ? → single
    - ?! combinations → ?
    - ALL CAPS words (5+ letters) → Title Case
    - Add spaces around em-dashes for pausing
    - ... → Unicode ellipsis (…)
    """
    # Multiple consecutive exclamation marks → single
    text = re.sub(r'!{2,}', '!', text)
    # Multiple consecutive question marks → single
    text = re.sub(r'\?{2,}', '?', text)
    # Mixed multiple punctuation (e.g., ?!!, !?) → single ?
    text = re.sub(r'[?!]{2,}', '?', text)

    # ALL CAPS words (5+ letters) → Title Case
    def fix_all_caps(match):
        word = match.group(0)
        if len(word) >= 5:
            return word.title()
        return word

    text = re.sub(r'\b[A-Z]{5,}\b', fix_all_caps, text)

    # Add spaces around em-dashes for better pausing
    text = re.sub(r'(\S)—(\S)', r'\1 — \2', text)
    text = re.sub(r'(\S)--(\S)', r'\1 -- \2', text)

    # ... → Unicode ellipsis
    text = re.sub(r'\.{3,}', '…', text)

    return text


def normalize_text(text: str) -> str:
    """
    Normalize numbers, dates, currency, and abbreviations for better TTS.
    Uses num2words library + regex expansions.
    """
    from num2words import num2words

    # Common abbreviations
    abbreviations = {
        r'\bDr\.\b': 'Doctor',
        r'\bMr\.\b': 'Mister',
        r'\bMrs\.\b': 'Missus',
        r'\bMs\.\b': 'Miss',
        r'\bSt\.\b': 'Saint',
        r'\bAve\.\b': 'Avenue',
        r'\bBlvd\.\b': 'Boulevard',
        r'\bRd\.\b': 'Road',
        r'\bLn\.\b': 'Lane',
        r'\betc\.\b': 'et cetera',
        r'\bi\.e\.\b': 'that is',
        r'\be\.g\.\b': 'for example',
        r'\bvs\.\b': 'versus',
        r'\bvol\.\b': 'volume',
        r'\bVol\.\b': 'Volume',
        r'\bno\.\b': 'number',
        r'\bNo\.\b': 'Number',
        r'\bpp\.\b': 'pages',
        r'\bpg\.\b': 'page',
        r'\bPg\.\b': 'Page',
        r'\bch\.\b': 'chapter',
        r'\bCh\.\b': 'Chapter',
        r'\bsec\.\b': 'section',
        r'\bSec\.\b': 'Section',
    }

    for pattern, replacement in abbreviations.items():
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)

    # Currency: $1,234.56 → words
    def currency_to_words(match):
        dollars = match.group(1).replace(',', '')
        cents = match.group(2)
        try:
            dollar_words = num2words(int(dollars))
            cent_words = num2words(int(cents))
            return f"{dollar_words} dollars and {cent_words} cents"
        except:
            return match.group(0)

    text = re.sub(r'\$(\d{1,3}(?:,\d{3})+)(?:\.(\d{2}))?', currency_to_words, text)
    text = re.sub(r'\$(\d+)(?:\.(\d{2}))?', currency_to_words, text)

    # Percentages: 50% → fifty percent
    def percent_to_words(match):
        try:
            return num2words(int(match.group(1))) + " percent"
        except:
            return match.group(0)

    text = re.sub(r'(\d+)%', percent_to_words, text)

    # Times: 3:45 PM → three forty-five PM (simple conversion)
    def time_to_words(match):
        hour = match.group(1)
        minute = match.group(2)
        period = match.group(3) if match.group(3) else ""
        try:
            hour_words = num2words(int(hour))
            minute_words = num2words(int(minute))
            return f"{hour_words} {minute_words} {period}".strip()
        except:
            return match.group(0)

    text = re.sub(r'\b(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?\b', time_to_words, text)

    # Large numbers with commas: 1,234,567 → words
    def large_number_to_words(match):
        try:
            return num2words(int(match.group(0).replace(',', '')))
        except:
            return match.group(0)

    text = re.sub(r'\b\d{1,3}(?:,\d{3})+\b', large_number_to_words, text)

    # Standalone large numbers (>20): 42 → forty-two
    def number_to_words(match):
        num = int(match.group(0))
        if num > 20:
            try:
                return num2words(num)
            except:
                return match.group(0)
        return match.group(0)

    text = re.sub(r'\b\d{2,}\b', number_to_words, text)

    return text


def split_text_into_paragraphs(text: str, max_chars: int = MAX_PARAGRAPH_CHARS) -> List[str]:
    """
    Split text at paragraph boundaries (\n\n).
    If paragraph > max_chars, split at sentence boundaries.
    If single sentence > max_chars, split at comma/word boundary.
    """
    # First split by double newlines (paragraphs)
    raw_paragraphs = re.split(r'\n\s*\n', text.strip())

    paragraphs = []

    for para in raw_paragraphs:
        para = para.strip()
        if not para:
            continue

        if len(para) <= max_chars:
            paragraphs.append(para)
        else:
            # Paragraph too long - split at sentence boundaries
            sentences = re.split(r'(?<=[.!?])\s+', para)

            current = []
            current_len = 0

            for sentence in sentences:
                sentence = sentence.strip()
                if not sentence:
                    continue

                sent_len = len(sentence)

                if current_len + sent_len + 1 <= max_chars:
                    current.append(sentence)
                    current_len += sent_len + 1
                else:
                    # Flush current paragraph
                    if current:
                        paragraphs.append(" ".join(current))

                    # If single sentence > max_chars, split at word boundary
                    if sent_len > max_chars:
                        words = sentence.split()
                        current = []
                        current_len = 0
                        for word in words:
                            word_len = len(word)
                            if current_len + word_len + 1 <= max_chars:
                                current.append(word)
                                current_len += word_len + 1
                            else:
                                if current:
                                    paragraphs.append(" ".join(current))
                                current = [word]
                                current_len = word_len
                    else:
                        current = [sentence]
                        current_len = sent_len

            # Flush remaining
            if current:
                paragraphs.append(" ".join(current))

    return [p for p in paragraphs if p.strip()]


def analyze_paragraph(text: str) -> tuple:
    """
    Analyze paragraph characteristics and return (speed, cfg_strength) adjustments.

    Returns:
        tuple: (speed_adjustment, cfg_strength)
    """
    speed = BASE_SPEED

    # Check for dialogue (contains quotes)
    has_dialogue = '"' in text or '"' in text or '"' in text or "'" in text
    if has_dialogue:
        speed += 0.04

    # Calculate average sentence length
    sentences = re.split(r'(?<=[.!?])\s+', text)
    sentences = [s for s in sentences if s.strip()]

    if sentences:
        avg_words_per_sentence = sum(len(s.split()) for s in sentences) / len(sentences)

        # Action: short sentences
        if avg_words_per_sentence < 8:
            speed += 0.05

        # Description: long sentences with many commas
        comma_count = text.count(',')
        if avg_words_per_sentence > 15 and comma_count >= 2:
            speed -= 0.04

    # Exclamations
    if '!' in text:
        speed += 0.02

    # Questions
    if '?' in text:
        speed -= 0.02

    # Long words (avg > 6 chars)
    words = text.split()
    if words:
        avg_word_len = sum(len(w.strip('.,!?;:"()[]')) for w in words) / len(words)
        if avg_word_len > 6:
            speed -= 0.03

    # Clamp speed
    speed = max(MIN_SPEED, min(MAX_SPEED, speed))

    # CFG strength: higher for dialogue to maintain speaker consistency
    cfg_strength = DIALOGUE_CFG_STRENGTH if has_dialogue else DEFAULT_CFG_STRENGTH

    return speed, cfg_strength


# ── Audio Helpers ─────────────────────────────────────────────────────────

def transcribe_with_whisper(audio_path: str) -> str:
    """
    Transcribe audio using faster-whisper base model.
    Returns transcript text to use as ref_text for F5-TTS.
    """
    from faster_whisper import WhisperModel

    model = WhisperModel("base", device="cpu", compute_type="int8")
    segments, _ = model.transcribe(audio_path, language="en", beam_size=5)

    transcript = " ".join([segment.text for segment in segments])
    return transcript.strip()


def clean_audio_with_demucs(audio_base64: str, audio_cleaner_url: str, webhook_secret: str = "") -> str:
    """
    Clean audio using the deployed audio cleaner service.
    Returns cleaned audio as base64 string.
    """
    import httpx

    headers = {"X-Webhook-Secret": webhook_secret} if webhook_secret else {}

    try:
        with httpx.Client(timeout=60.0) as client:
            response = client.post(
                audio_cleaner_url,
                json={
                    "audio_base64": audio_base64,
                    "target_sample_rate": 24000,
                    "normalize_loudness": True,
                    "target_lufs": -16.0,
                },
                headers=headers,
            )

            if response.status_code == 200:
                result = response.json()
                return result.get("audio_base64", audio_base64)
            else:
                print(f"[Audio Cleaner] Failed with status {response.status_code}: {response.text}")
                return audio_base64  # Return original on failure
    except Exception as e:
        print(f"[Audio Cleaner] Error: {e}")
        return audio_base64  # Return original on failure


# ── Helpers ───────────────────────────────────────────────────────────────

@contextmanager
def temp_audio_file(audio_bytes: bytes, suffix: str = ".wav"):
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name
        yield tmp_path
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception:
                pass


def get_r2_client():
    """Create boto3 S3 client for Cloudflare R2 from environment variables."""
    import boto3
    from botocore.config import Config
    account_id = os.environ.get("R2_ACCOUNT_ID", "")
    access_key = os.environ.get("R2_ACCESS_KEY_ID", "")
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY", "")
    if not all([account_id, access_key, secret_key]):
        raise ValueError("R2 credentials not configured")
    config = Config(connect_timeout=30, read_timeout=60)
    return boto3.client(
        "s3",
        region_name="auto",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=config,
    )


def verify_r2_permissions(client, bucket: str):
    """Verify R2 permissions by attempting to list the bucket."""
    try:
        client.list_objects_v2(Bucket=bucket, MaxKeys=1)
        return True
    except Exception as e:
        print(f"[R2] Permission check failed: {e}")
        return False


def download_from_r2(client, bucket: str, key: str, local_path: str):
    """Download from R2. Uses get_object directly to avoid HeadObject permission issues."""
    try:
        response = client.get_object(Bucket=bucket, Key=key)
        with open(local_path, "wb") as f:
            f.write(response["Body"].read())
    except Exception as e:
        print(f"[R2] get_object failed for {bucket}/{key}: {e}")
        client.download_file(bucket, key, local_path)


def upload_to_r2(client, bucket: str, key: str, local_path: str, content_type: str = "application/octet-stream"):
    client.upload_file(local_path, bucket, key, ExtraArgs={"ContentType": content_type})


def split_text_into_sections(text: str, max_chunk_size: int = MAX_PARAGRAPH_CHARS) -> List[str]:
    """
    Split text into paragraph-based chunks for better F5-TTS prosody.
    Uses paragraph boundaries with sentence-level fallback for long paragraphs.
    """
    return split_text_into_paragraphs(text, max_chars=max_chunk_size)


def clip_audio_ffmpeg(input_path: str, output_path: str, start_time: float, duration: float, sample_rate: int = 24000):
    cmd = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-ss", str(start_time),
        "-t", str(duration),
        "-ac", "1",
        "-ar", str(sample_rate),
        output_path,
    ]
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def concatenate_audio_ffmpeg(audio_files: List[str], output_path: str, crossfade_duration: float = 0.05):
    if len(audio_files) == 0:
        raise ValueError("No audio files to concatenate")
    if len(audio_files) == 1:
        shutil.copy(audio_files[0], output_path)
        return

    if len(audio_files) == 2:
        cmd = [
            "ffmpeg", "-y",
            "-i", audio_files[0],
            "-i", audio_files[1],
            "-filter_complex", f"[0][1]acrossfade=d={crossfade_duration}:c1=tri:c2=tri",
            output_path,
        ]
    else:
        inputs = []
        for f in audio_files:
            inputs.extend(["-i", f])
        filter_parts = [f"[0][1]acrossfade=d={crossfade_duration}:c1=tri:c2=tri[a01]"]
        for i in range(2, len(audio_files)):
            prev = f"a{i-2:02d}" if i > 2 else "a01"
            filter_parts.append(f"[{prev}][{i}]acrossfade=d={crossfade_duration}:c1=tri:c2=tri[a{i-1:02d}]")
        filter_str = ";".join(filter_parts)
        output_label = f"a{len(audio_files)-2:02d}"
        cmd = ["ffmpeg", "-y"] + inputs + [
            "-filter_complex", filter_str,
            "-map", f"[{output_label}]",
            output_path,
        ]

    subprocess.run(cmd, check=True, capture_output=True, text=True)


def normalize_audio_ffmpeg(input_path: str, output_path: str, sample_rate: int = 24000):
    """
    Lightweight audio post-processing.

    F5-TTS already outputs clean 24kHz audio, so heavy processing (compression,
    EQ, limiting) was degrading quality and causing muffled output.  Now we only
    apply loudness normalization (ITU-R BS.1770-4) with a gentle high-pass to
    remove sub-bass rumble.
    """
    cmd = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-af",
        "highpass=f=80,"
        "loudnorm=I=-16:TP=-1.5:LRA=11",
        "-ar", str(sample_rate),
        "-b:a", "192k",
        output_path,
    ]
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def insert_silence_between_chunks(audio_files: List[str], output_path: str, silence_duration: float = PARAGRAPH_SILENCE):
    """
    Insert silence between audio chunks via apad trailing silence + concat.
    """
    if len(audio_files) == 0:
        raise ValueError("No audio files to concatenate")
    if len(audio_files) == 1:
        shutil.copy(audio_files[0], output_path)
        return

    inputs = []
    for f in audio_files:
        inputs.extend(["-i", f])

    filter_parts = []
    for i in range(len(audio_files) - 1):
        filter_parts.append(f"[{i}:a]apad=pad_dur={silence_duration}[padded{i}]")

    inputs_str = "".join([f"[padded{i}]" for i in range(len(audio_files) - 1)]) + f"[{len(audio_files) - 1}:a]"
    filter_parts.append(f"{inputs_str}concat=n={len(audio_files)}:v=0:a=1[out]")

    cmd = ["ffmpeg", "-y"] + inputs + ["-filter_complex", ";".join(filter_parts), "-map", "[out]", output_path]
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def send_webhook_sync(url: str, payload: dict, max_retries: int = 3):
    """Send webhook synchronously with retries."""
    import httpx
    headers = {"X-Webhook-Secret": os.environ.get("WEBHOOK_SECRET", "")}
    for attempt in range(max_retries):
        try:
            with httpx.Client(timeout=15.0) as client:
                response = client.post(url, json=payload, headers=headers)
                print(f"[Webhook] {url} -> {response.status_code}")
                if response.status_code < 400:
                    return True
        except Exception as e:
            print(f"[Webhook] Attempt {attempt + 1} failed: {e}")
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)
    print(f"[Webhook] All {max_retries} attempts failed")
    return False


def send_webhook_async(url: str, payload: dict):
    """Fire-and-forget webhook in a background thread. Never blocks generation."""
    def _send():
        try:
            send_webhook_sync(url, payload)
        except Exception as e:
            print(f"[Webhook Async] Failed: {e}")
    threading.Thread(target=_send, daemon=True).start()


def _decode_audio_for_worker(audio_base64: str) -> tuple:
    import soundfile as sf
    audio_bytes = base64.b64decode(audio_base64)
    audio_io = io.BytesIO(audio_bytes)
    audio, sr = sf.read(audio_io)
    if len(audio.shape) > 1:
        audio = audio.mean(axis=1)
    return audio, sr


# ── GPU: F5-TTS Server (for voice preview) ────────────────────────────────

@app.cls(
    gpu=GPU_CONFIG,
    scaledown_window=300,
    timeout=600,
    volumes={"/cache": volume},
    max_containers=1,
    secrets=[modal.Secret.from_name("echomancer-secrets"), modal.Secret.from_name("echomancer-f5-tts")],
)
class F5TTSServer:
    model: object = None
    device: str = "cuda"
    model_loaded: bool = False

    @modal.enter()
    def setup(self):
        import torch
        from f5_tts.api import F5TTS
        os.makedirs("/cache/models", exist_ok=True)
        self.model = F5TTS(
            model="F5TTS_v1_Base",
            device=self.device,
            hf_cache_dir="/cache/models",
        )
        self.model_loaded = True

    def _decode_audio(self, audio_base64: str) -> tuple:
        import soundfile as sf
        audio_bytes = base64.b64decode(audio_base64)
        audio_io = io.BytesIO(audio_bytes)
        audio, sr = sf.read(audio_io)
        if len(audio.shape) > 1:
            audio = audio.mean(axis=1)
        return audio, sr

    @modal.method()
    def generate_batch(self, request: BatchTTSRequest) -> dict:
        import torch
        import soundfile as sf
        batch_start = time.time()
        ref_audio, ref_sr = self._decode_audio(request.reference_audio_base64)
        max_samples = int(15 * ref_sr)
        if len(ref_audio) > max_samples:
            start = (len(ref_audio) - max_samples) // 2
            ref_audio = ref_audio[start:start + max_samples]
        results = []
        with temp_audio_file(b"") as ref_path:
            sf.write(ref_path, ref_audio, ref_sr)
            for text in request.texts:
                try:
                    with torch.inference_mode():
                        wav, sr, _ = self.model.infer(
                            ref_file=ref_path,
                            ref_text=request.reference_text or "",
                            gen_text=text,
                            nfe_step=request.nfe_step,
                            cfg_strength=request.cfg_strength,
                            speed=request.speed,
                        )
                    output_buffer = io.BytesIO()
                    sf.write(output_buffer, wav, sr, format="WAV")
                    output_buffer.seek(0)
                    audio_base64 = base64.b64encode(output_buffer.read()).decode("utf-8")
                    results.append({
                        "audio_base64": audio_base64,
                        "duration_seconds": len(wav) / sr,
                        "error": None,
                    })
                except Exception as e:
                    results.append({
                        "audio_base64": None,
                        "duration_seconds": 0,
                        "error": str(e),
                    })
        return {
            "results": results,
            "total_segments": len(request.texts),
            "total_time_seconds": time.time() - batch_start,
        }

    @modal.method()
    def generate_paragraph(self, paragraph_request: ParagraphRequest, voice_base64: str, ref_text: Optional[str] = None) -> dict:
        """
        Generate audio for a single paragraph with custom speed and cfg_strength.
        More efficient than batch for paragraph-level processing.
        """
        import torch
        import soundfile as sf

        start_time = time.time()

        try:
            # Decode reference audio
            ref_audio, ref_sr = self._decode_audio(voice_base64)
            max_samples = int(15 * ref_sr)
            if len(ref_audio) > max_samples:
                start = (len(ref_audio) - max_samples) // 2
                ref_audio = ref_audio[start:start + max_samples]

            with temp_audio_file(b"") as ref_path:
                sf.write(ref_path, ref_audio, ref_sr)

                with torch.inference_mode():
                    wav, sr, _ = self.model.infer(
                        ref_file=ref_path,
                        ref_text="",
                        gen_text=paragraph_request.text,
                        nfe_step=32,
                        cfg_strength=paragraph_request.cfg_strength,
                        speed=paragraph_request.speed,
                    )

                output_buffer = io.BytesIO()
                sf.write(output_buffer, wav, sr, format="WAV")
                output_buffer.seek(0)
                audio_base64 = base64.b64encode(output_buffer.read()).decode("utf-8")

                return {
                    "audio_base64": audio_base64,
                    "duration_seconds": len(wav) / sr,
                    "speed": paragraph_request.speed,
                    "cfg_strength": paragraph_request.cfg_strength,
                    "error": None,
                    "elapsed_seconds": time.time() - start_time,
                }

        except Exception as e:
            return {
                "audio_base64": None,
                "duration_seconds": 0,
                "speed": paragraph_request.speed,
                "cfg_strength": paragraph_request.cfg_strength,
                "error": str(e),
                "elapsed_seconds": time.time() - start_time,
            }


# ── GPU: Audiobook Chunk Worker (parallel, keep_warm) ─────────────────────

@app.cls(
    gpu=GPU_CONFIG,
    scaledown_window=600,
    timeout=600,
    volumes={"/cache": volume},
    max_containers=4,
    secrets=[modal.Secret.from_name("echomancer-secrets"), modal.Secret.from_name("echomancer-f5-tts")],
)
class F5TTSAudiobookWorker:
    """
    GPU worker for processing chunks of an audiobook.
    Containers spin down after 10 min of inactivity (scaledown_window=600).
    Warmup is triggered by the frontend when users open the site.
    max_containers=4 allows up to 4 parallel containers.
    """
    model: object = None
    device: str = "cuda"

    @modal.enter()
    def setup(self):
        import torch
        from f5_tts.api import F5TTS
        os.makedirs("/cache/models", exist_ok=True)
        self.model = F5TTS(
            model="F5TTS_v1_Base",
            device=self.device,
            hf_cache_dir="/cache/models",
        )
        print("[Worker] Model loaded and ready")

    @modal.method()
    def warmup(self, dummy: int = 0) -> dict:
        """Lightweight method to force container spin-up and model load."""
        return {
            "status": "warm",
            "model_loaded": True,
            "device": self.device,
            "container_id": dummy,
        }

    @modal.method()
    def process_sections(self, request_dict: dict) -> dict:
        """
        Process a group of paragraphs with per-paragraph speed/cfg variation.
        Each paragraph is generated as a single F5-TTS inference with its own parameters.
        Returns dict with status; errors are caught internally so .map() never aborts.
        """
        import torch
        import soundfile as sf

        job_id = request_dict.get("job_id", "unknown")
        chunk_index = request_dict.get("chunk_index", 0)
        paragraphs = request_dict.get("paragraphs", [])  # List of dicts with text, speed, cfg_strength
        voice_base64 = request_dict.get("voice_base64", "")
        voice_r2_key = request_dict.get("voice_r2_key", "")
        ref_text = request_dict.get("ref_text", "")  # Whisper transcript of voice sample
        webhook_url = request_dict.get("webhook_url", "")
        total_paragraphs_global = request_dict.get("total_paragraphs", len(paragraphs))
        r2_bucket = request_dict.get("r2_bucket_name", "echomancer-audio")

        if not paragraphs:
            return {"status": "error", "error": "No paragraphs provided", "chunk_index": chunk_index}

        temp_dir = tempfile.mkdtemp(prefix=f"echomancer_{job_id}_chunk{chunk_index}_")
        start_time = time.time()

        try:
            # Decode reference audio — prefer R2 download over base64 payload
            if voice_r2_key:
                try:
                    r2 = get_r2_client()
                    voice_tmp = os.path.join(temp_dir, "voice_from_r2.wav")
                    r2.download_file(r2_bucket, voice_r2_key, voice_tmp)
                    with open(voice_tmp, "rb") as f:
                        voice_bytes_r2 = f.read()
                    voice_b64 = base64.b64encode(voice_bytes_r2).decode("utf-8")
                    ref_audio, ref_sr = _decode_audio_for_worker(voice_b64)
                    print(f"[Job {job_id}][Chunk {chunk_index}] Voice loaded from R2")
                except Exception as e:
                    print(f"[Job {job_id}][Chunk {chunk_index}] R2 voice download failed, using base64: {e}")
                    ref_audio, ref_sr = _decode_audio_for_worker(voice_base64)
            else:
                ref_audio, ref_sr = _decode_audio_for_worker(voice_base64)
            max_samples = int(15 * ref_sr)
            if len(ref_audio) > max_samples:
                start = (len(ref_audio) - max_samples) // 2
                ref_audio = ref_audio[start:start + max_samples]

            ref_path = os.path.join(temp_dir, "ref.wav")
            sf.write(ref_path, ref_audio, ref_sr)

            # Generate each paragraph with its own speed/cfg parameters
            paragraph_files = []
            failed_local = []
            speed_info = []  # Track speed for debugging

            for i, para_data in enumerate(paragraphs):
                text = para_data.get("text", "")
                speed = para_data.get("speed", BASE_SPEED)
                cfg_strength = para_data.get("cfg_strength", DEFAULT_CFG_STRENGTH)

                if not text.strip():
                    continue

                try:
                    with torch.inference_mode():
                        wav, sr, _ = self.model.infer(
                            ref_file=ref_path,
                            ref_text="",  # ref_text is concatenated into output audio by F5-TTS;
                                          # passing it here would prepend it to every paragraph
                            gen_text=text,
                            nfe_step=32,
                            cfg_strength=cfg_strength,
                            speed=speed,
                        )
                    para_path = os.path.join(temp_dir, f"para_{i:04d}.wav")
                    sf.write(para_path, wav, sr, format="WAV")
                    paragraph_files.append(para_path)
                    speed_info.append(f"{speed:.2f}")
                except Exception as e:
                    print(f"[Worker {job_id}] Paragraph {i} failed: {e}")
                    failed_local.append(i)

            if not paragraph_files:
                return {"status": "error", "error": "All paragraphs failed", "chunk_index": chunk_index}

            # Concatenate paragraphs with silence between them
            chunk_audio_path = os.path.join(temp_dir, f"chunk_{chunk_index}.wav")
            insert_silence_between_chunks(paragraph_files, chunk_audio_path, silence_duration=PARAGRAPH_SILENCE)

            # Upload partial chunk to R2
            r2 = get_r2_client()
            chunk_r2_key = f"audiobooks/{job_id}/chunks/chunk_{chunk_index:03d}.wav"
            upload_to_r2(r2, r2_bucket, chunk_r2_key, chunk_audio_path, "audio/wav")

            duration = 0.0
            try:
                info = sf.info(chunk_audio_path)
                duration = info.duration
            except Exception:
                pass

            elapsed = time.time() - start_time
            print(f"[Worker {job_id}] Chunk {chunk_index} done: {len(paragraph_files)}/{len(paragraphs)} paragraphs, speeds=[{','.join(speed_info)}], {duration:.1f}s audio, {elapsed:.1f}s wall")

            # Fire-and-forget progress webhook
            if webhook_url:
                send_webhook_async(webhook_url, {
                    "job_id": job_id,
                    "status": "processing",
                    "progress": 10 + int((chunk_index + 1) / max(1, request_dict.get("total_chunks", 1)) * 60),
                    "message": f"Chunk {chunk_index + 1} complete",
                })

            return {
                "status": "success",
                "chunk_index": chunk_index,
                "r2_key": chunk_r2_key,
                "duration_seconds": duration,
                "paragraphs_done": len(paragraph_files),
                "paragraphs_failed": len(failed_local),
                "speeds_used": speed_info,
                "elapsed_seconds": elapsed,
            }

        except Exception as e:
            traceback_str = traceback.format_exc()
            print(f"[Worker {job_id}] Chunk {chunk_index} crashed: {e}\n{traceback_str}")
            return {
                "status": "error",
                "chunk_index": chunk_index,
                "error": str(e),
            }
        finally:
            try:
                shutil.rmtree(temp_dir, ignore_errors=True)
            except Exception:
                pass


# ── GPU: Audiobook Orchestrator (standalone, spawns chunk workers) ─────────

# Orchestrator runs on CPU — it downloads, splits text, farms chunks, concatenates.
# GPU is only needed in F5TTSAudiobookWorker.process_sections.
@app.function(
    scaledown_window=300,
    timeout=3600,
    volumes={"/cache": volume},
    secrets=[modal.Secret.from_name("echomancer-secrets"), modal.Secret.from_name("echomancer-f5-tts")],
)
def process_audiobook(request_dict: dict) -> dict:
    """
    Orchestrator: downloads assets, splits text, farms chunks to workers via .map(),
    then concatenates partials and uploads the final audiobook.
    """
    job_id = request_dict.get("job_id", "unknown")
    print(f"[Job {job_id}] Orchestrator STARTED")

    import fitz  # pymupdf

    request = AudiobookRequest(**request_dict)
    temp_dir = tempfile.mkdtemp(prefix=f"echomancer_{job_id}_")

    def cleanup():
        try:
            shutil.rmtree(temp_dir, ignore_errors=True)
        except Exception:
            pass

    try:
        r2 = get_r2_client()

        # Verify R2 permissions
        if not verify_r2_permissions(r2, request.r2_bucket_name):
            raise ValueError(
                f"R2 permissions check failed. Ensure your R2 token has 'Object Read & Write' permission."
            )

        # ── Step 1: Download document and extract text ──────────────
        if request.pre_extracted_text:
            # Non-PDF formats: text was already extracted by the Next.js server
            print(f"[Job {job_id}] Step 1-2: Using pre-extracted text ({len(request.pre_extracted_text)} chars)")
            text = re.sub(r"\s+", " ", request.pre_extracted_text).strip()
        else:
            # PDF: download and extract text here
            print(f"[Job {job_id}] Step 1: Downloading PDF from R2...")
            pdf_path = os.path.join(temp_dir, "input.pdf")
            download_from_r2(r2, request.r2_bucket_name, request.pdf_r2_key, pdf_path)

            print(f"[Job {job_id}] Step 2: Extracting text from PDF...")
            doc = fitz.open(pdf_path)
            if doc.is_encrypted or doc.needs_pass:
                doc.close()
                raise ValueError("PDF is encrypted or password-protected")
            pages = [page.get_text() for page in doc]
            raw_text = "".join(pages)
            doc.close()

            if not raw_text.strip():
                raise ValueError("Could not extract text from PDF. Is it a scanned document?")

            text = re.sub(r"\s+", " ", raw_text).strip()

        print(f"[Job {job_id}] Extracted {len(text)} characters")

        # ── Step 3: Download and clip voice sample ────────────────────
        print(f"[Job {job_id}] Step 3: Downloading voice from R2...")
        voice_path = os.path.join(temp_dir, "voice_raw")
        download_from_r2(r2, request.r2_bucket_name, request.voice_r2_key, voice_path)

        clip_duration = request.end_time - request.start_time
        if clip_duration < 3:
            clip_duration = 3
        if clip_duration > 30:
            clip_duration = 30

        voice_clipped_path = os.path.join(temp_dir, "voice_clipped.wav")
        clip_audio_ffmpeg(voice_path, voice_clipped_path, request.start_time, clip_duration)

        # ── Step 3b: Vocal isolation via Audio Cleaner service ───────────
        print(f"[Job {job_id}] Step 3b: Cleaning voice sample via Audio Cleaner service...")
        voice_cleaned_path = os.path.join(temp_dir, "voice_cleaned.wav")
        voice_final_path = voice_clipped_path  # Default to clipped if cleaning fails

        # Get Audio Cleaner URL from environment
        audio_cleaner_url = os.environ.get("AUDIO_CLEANER_URL", "").rstrip("/")
        if audio_cleaner_url:
            try:
                import httpx

                with open(voice_clipped_path, "rb") as f:
                    voice_clipped_bytes = f.read()
                voice_clipped_b64 = base64.b64encode(voice_clipped_bytes).decode("utf-8")

                with httpx.Client(timeout=60.0) as client:
                    response = client.post(
                        f"{audio_cleaner_url}/clean",
                        json={
                            "audio_base64": voice_clipped_b64,
                            "target_sample_rate": 24000,
                            "normalize_loudness": True,
                            "target_lufs": -16.0,
                        }
                    )

                    if response.status_code == 200:
                        result = response.json()
                        cleaned_b64 = result.get("audio_base64")
                        if cleaned_b64:
                            cleaned_bytes = base64.b64decode(cleaned_b64)
                            with open(voice_cleaned_path, "wb") as f:
                                f.write(cleaned_bytes)
                            print(f"[Job {job_id}] Voice cleaned successfully (Audio Cleaner service)")
                            voice_final_path = voice_cleaned_path
                        else:
                            print(f"[Job {job_id}] Audio Cleaner returned no audio, using clipped")
                    else:
                        print(f"[Job {job_id}] Audio Cleaner failed ({response.status_code}), using clipped")

            except Exception as e:
                print(f"[Job {job_id}] Audio Cleaner call failed (non-critical): {e}")
        else:
            print(f"[Job {job_id}] No AUDIO_CLEANER_URL set, using clipped audio")

        with open(voice_final_path, "rb") as f:
            voice_bytes = f.read()
        voice_base64 = base64.b64encode(voice_bytes).decode("utf-8")

        # Upload processed voice to R2 so workers can download it instead of
        # receiving the full base64 payload in every chunk request
        voice_r2_key = f"audiobooks/{job_id}/voice_processed.wav"
        try:
            upload_to_r2(r2, request.r2_bucket_name, voice_r2_key, voice_final_path, "audio/wav")
            print(f"[Job {job_id}] Voice uploaded to R2 ({voice_r2_key})")
        except Exception as e:
            voice_r2_key = ""
            print(f"[Job {job_id}] Failed to upload voice to R2, will use base64 fallback: {e}")

        print(f"[Job {job_id}] Voice sample ready ({clip_duration}s)")

        # ── Step 4: Text normalization ───────────────────────────────
        print(f"[Job {job_id}] Step 4: Normalizing text...")
        text = normalize_punctuation(text)
        text = normalize_text(text)

        # ── Step 5: Whisper transcription for ref_text ─────────────────
        print(f"[Job {job_id}] Step 5: Transcribing voice sample with Whisper...")
        ref_text = ""
        try:
            ref_text = transcribe_with_whisper(voice_final_path)
            print(f"[Job {job_id}] Voice transcript: {ref_text[:100]}...")
        except Exception as e:
            print(f"[Job {job_id}] Whisper transcription failed (non-critical): {e}")
            ref_text = ""  # F5-TTS will use empty ref_text (invented cadence)

        # ── Step 6: Split text into paragraphs with speed analysis ─────
        print(f"[Job {job_id}] Step 6: Splitting text into paragraphs...")
        paragraphs_raw = split_text_into_paragraphs(text, max_chars=MAX_PARAGRAPH_CHARS)

        # Analyze each paragraph for speed/cfg variation
        paragraphs = []
        for para_text in paragraphs_raw:
            speed, cfg_strength = analyze_paragraph(para_text)
            paragraphs.append({
                "text": para_text,
                "speed": speed,
                "cfg_strength": cfg_strength,
            })

        total_paragraphs = len(paragraphs)
        print(f"[Job {job_id}] Split into {total_paragraphs} paragraphs (max {MAX_PARAGRAPH_CHARS} chars each)")

        if total_paragraphs == 0:
            raise ValueError("No paragraphs found")

        # Log speed distribution for debugging
        speed_distribution = {}
        for p in paragraphs:
            s = round(p["speed"], 2)
            speed_distribution[s] = speed_distribution.get(s, 0) + 1
        print(f"[Job {job_id}] Speed distribution: {speed_distribution}")

        # ── Step 7: Decide parallelism ────────────────────────────────
        # Split into 4 chunks to saturate 4 warm GPU containers
        NUM_CHUNKS = 4
        paragraphs_per_chunk = max(1, (total_paragraphs + NUM_CHUNKS - 1) // NUM_CHUNKS)

        chunk_requests = []
        for chunk_idx in range(NUM_CHUNKS):
            start = chunk_idx * paragraphs_per_chunk
            end = min(start + paragraphs_per_chunk, total_paragraphs)
            chunk_paragraphs = paragraphs[start:end]
            if not chunk_paragraphs:
                continue
            chunk_requests.append({
                "job_id": job_id,
                "chunk_index": chunk_idx,
                "paragraphs": chunk_paragraphs,  # Now includes speed/cfg per paragraph
                "voice_base64": "" if voice_r2_key else voice_base64,
                "voice_r2_key": voice_r2_key,
                "ref_text": ref_text,  # Whisper transcript for cadence cloning
                "webhook_url": request.webhook_url,
                "total_paragraphs": total_paragraphs,
                "total_chunks": len(chunk_requests) + 1,  # approximate, refined below
                "r2_bucket_name": request.r2_bucket_name,
            })

        # Fix total_chunks count after we know it
        total_chunks = len(chunk_requests)
        for cr in chunk_requests:
            cr["total_chunks"] = total_chunks

        print(f"[Job {job_id}] Farming {total_chunks} chunks to workers via .map()")

        send_webhook_async(request.webhook_url, {
            "job_id": job_id,
            "status": "processing",
            "progress": 10,
            "current_paragraph": 0,
            "total_paragraphs": total_paragraphs,
            "message": f"Starting parallel generation with {total_chunks} chunks",
        })

        # ── Step 8: Parallel generation via .map() ────────────────────
        worker = F5TTSAudiobookWorker()
        chunk_results = list(worker.process_sections.map(chunk_requests))

        # Check results — retry failed chunks once
        successful_chunks = []
        failed_chunks = []
        for res in chunk_results:
            if res.get("status") == "success":
                successful_chunks.append(res)
            else:
                failed_chunks.append(res)
                print(f"[Job {job_id}] Chunk {res.get('chunk_index', '?')} failed: {res.get('error', 'unknown')}")

        # Retry failed chunks once
        post_retry_failed = 0
        if failed_chunks:
            print(f"[Job {job_id}] Retrying {len(failed_chunks)} failed chunks...")
            retry_requests = []
            for fc in failed_chunks:
                chunk_idx = fc["chunk_index"]
                retry_requests.append(chunk_requests[chunk_idx])
            retry_results = list(worker.process_sections.map(retry_requests))
            for res in retry_results:
                if res.get("status") == "success":
                    successful_chunks.append(res)
                else:
                    post_retry_failed += 1
                    print(f"[Job {job_id}] Chunk {res.get('chunk_index', '?')} retry failed: {res.get('error', 'unknown')}")

        if not successful_chunks:
            raise ValueError("All chunks failed after retry.")

        # If any chunks still failed after retry, fail the whole job
        all_chunk_indices = set(range(total_chunks))
        success_indices = {c["chunk_index"] for c in successful_chunks}
        still_failed = all_chunk_indices - success_indices
        if still_failed:
            raise ValueError(f"Chunks {sorted(still_failed)} failed after retry. Failing job to avoid partial audiobook.")

        # Sort by chunk index
        successful_chunks.sort(key=lambda x: x["chunk_index"])

        send_webhook_async(request.webhook_url, {
            "job_id": job_id,
            "status": "processing",
            "progress": 75,
            "message": f"Chunks complete. {len(successful_chunks)}/{total_chunks} succeeded. Concatenating...",
        })

        # ── Step 9: Download partials and concatenate ─────────────────
        print(f"[Job {job_id}] Step 9: Downloading {len(successful_chunks)} partial audios...")
        partial_files = []
        for chunk in successful_chunks:
            local_path = os.path.join(temp_dir, f"partial_{chunk['chunk_index']:03d}.wav")
            download_from_r2(r2, request.r2_bucket_name, chunk["r2_key"], local_path)
            partial_files.append(local_path)

        concatenated_path = os.path.join(temp_dir, "concatenated.wav")
        concatenate_audio_ffmpeg(partial_files, concatenated_path)

        # ── Step 10: Lightweight audio post-processing ────────────────
        print(f"[Job {job_id}] Step 10: Post-processing (highpass + loudnorm)...")
        final_path = os.path.join(temp_dir, "audiobook.mp3")
        normalize_audio_ffmpeg(concatenated_path, final_path)

        # ── Step 11: Upload to R2 ────────────────────────────────────
        print(f"[Job {job_id}] Step 11: Uploading to R2...")
        output_key = f"audiobooks/{job_id}/audiobook.mp3"
        upload_to_r2(r2, request.r2_bucket_name, output_key, final_path, "audio/mpeg")

        file_size = os.path.getsize(final_path)

        # Get accurate duration via ffprobe instead of guessing from file size
        estimated_duration = 0
        try:
            probe_result = subprocess.run(
                ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
                 "-of", "default=noprint_wrappers=1:nokey=1", final_path],
                capture_output=True, text=True
            )
            estimated_duration = int(float(probe_result.stdout.strip()))
        except Exception:
            estimated_duration = int(file_size / 24000)  # fallback

        print(f"[Job {job_id}] Complete! Uploaded to {output_key} ({file_size} bytes, {estimated_duration}s audio)")

        # Clean up partial chunk files and temp voice from R2
        for chunk in successful_chunks:
            try:
                r2.delete_object(Bucket=request.r2_bucket_name, Key=chunk["r2_key"])
            except Exception as e:
                print(f"[Job {job_id}] Failed to delete partial chunk {chunk['r2_key']}: {e}")
        if voice_r2_key:
            try:
                r2.delete_object(Bucket=request.r2_bucket_name, Key=voice_r2_key)
            except Exception:
                pass

        # Final webhook — SYNCHRONOUS to prevent race with late async progress updates
        send_webhook_sync(request.webhook_url, {
            "job_id": job_id,
            "status": "ready",
            "progress": 100,
            "audio_storage_path": output_key,
            "duration_seconds": estimated_duration,
            "error_message": None,
        })

        return {
            "status": "success",
            "audio_storage_path": output_key,
            "duration_seconds": estimated_duration,
            "failed_chunks": post_retry_failed,
        }

    except Exception as e:
        error_msg = str(e)
        traceback_str = traceback.format_exc()
        print(f"[Job {job_id}] ERROR: {error_msg}")
        print(traceback_str)
        # Failure webhook — SYNCHRONOUS
        send_webhook_sync(request.webhook_url, {
            "job_id": job_id,
            "status": "failed",
            "progress": 0,
            "error_message": error_msg,
        })
        return {"status": "failed", "error": error_msg}

    finally:
        cleanup()


async def _do_keepalive_warmup(worker):
    """Background task: trigger warmup without blocking the HTTP response."""
    try:
        async for _ in worker.warmup.map.aio([0, 1, 2, 3]):
            pass
        print("[Keepalive] Warmup complete")
    except Exception as e:
        print(f"[Keepalive] Error: {e}")


# ── CPU: FastAPI Web Endpoint (instant cold start) ────────────────────────

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

web_app = FastAPI(title="Echomancer F5-TTS")

web_app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://echomancer-v2.vercel.app",
        "https://echomancer-v2-*.vercel.app",  # preview deploys
        "http://localhost:3000",                # local dev
    ],
    allow_origin_regex=r"https://echomancer-v2-.*\.vercel\.app",
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.function()
@modal.asgi_app()
def fastapi_app():
    """CPU-only web endpoint. Instantly returns on cold start."""

    @web_app.get("/health")
    async def health() -> JSONResponse:
        return JSONResponse({
            "status": "ok",
            "timestamp": time.time(),
        })

    @web_app.get("/keepalive")
    async def keepalive() -> JSONResponse:
        """
        Lightweight ping to keep GPU containers warm.
        Call every 5 minutes to prevent scaledown.
        """
        try:
            worker = F5TTSAudiobookWorker()
            import asyncio
            # Fire-and-forget warmup — we don't wait for containers to fully load
            asyncio.create_task(_do_keepalive_warmup(worker))
            return JSONResponse({"status": "pinged", "timestamp": time.time()})
        except Exception as e:
            return JSONResponse({"status": "error", "message": str(e)})

    @web_app.post("/generate_batch")
    async def generate_batch_endpoint(request: dict) -> JSONResponse:
        """Voice preview — proxies to GPU container."""
        try:
            server = F5TTSServer()
            batch_request = BatchTTSRequest(
                texts=request["texts"],
                reference_audio_base64=request["reference_audio_base64"],
                reference_text=request.get("reference_text"),
                speed=request.get("speed", BASE_SPEED),  # Default 0.88 for natural pacing
                cfg_strength=request.get("cfg_strength", 2.0),
                nfe_step=request.get("nfe_step", 32),
            )
            result = await server.generate_batch.remote.aio(batch_request)
            return JSONResponse(content=result)
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    @web_app.post("/warmup")
    async def warmup_endpoint(request: dict) -> JSONResponse:
        """
        Warm up GPU containers ahead of time.
        Call this when user opens the site / dashboard to pre-load F5-TTS.
        """
        try:
            n = request.get("containers", 4)
            n = max(1, min(n, 4))
            worker = F5TTSAudiobookWorker()
            dummies = list(range(n))
            print(f"[API] Warming up {n} GPU containers...")
            # Use async for ... in map.aio() because we're inside an async function
            results = []
            async for res in worker.warmup.map.aio(dummies):
                results.append(res)
            print(f"[API] Warmup complete: {len(results)} containers ready")
            return JSONResponse({
                "status": "warm",
                "containers_ready": len(results),
                "results": results,
            })
        except Exception as e:
            print(f"[API] Warmup failed: {e}")
            import traceback
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=str(e))

    @web_app.post("/generate_audiobook")
    async def generate_audiobook_endpoint(request: dict) -> JSONResponse:
        """
        Queue a full audiobook generation job.
        Returns immediately; processing happens in a background GPU task.
        """
        try:
            req = AudiobookRequest(
                job_id=request["job_id"],
                pdf_r2_key=request["pdf_r2_key"],
                voice_r2_key=request["voice_r2_key"],
                start_time=request.get("start_time", 0),
                end_time=request.get("end_time", 30),
                webhook_url=request["webhook_url"],
                book_title=request.get("book_title", "Untitled"),
                voice_name=request.get("voice_name", "Unknown"),
                r2_bucket_name=request.get("r2_bucket_name", "echomancer-audio"),
                pre_extracted_text=request.get("pre_extracted_text", ""),
            )
            print(f"[API] Spawning process_audiobook for job {req.job_id}")
            call = await process_audiobook.spawn.aio(req.__dict__)
            print(f"[API] Spawned process_audiobook for job {req.job_id}, call_id={call.object_id}")
            return JSONResponse(content={
                "status": "accepted",
                "job_id": req.job_id,
                "message": "Audiobook generation started",
                "call_id": call.object_id,
            })
        except Exception as e:
            print(f"[API] Failed to spawn process_audiobook: {e}")
            import traceback
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=str(e))

    return web_app
