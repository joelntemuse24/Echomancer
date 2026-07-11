"""Shared TTS orchestration helpers (R2, ffmpeg, text, webhooks). No Modal app definitions."""

from __future__ import annotations

import base64
import io
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import math
from typing import List

MAX_PARAGRAPH_CHARS = 1500
PARAGRAPH_SILENCE = float(os.environ.get("MOSS_PARAGRAPH_PAUSE_SEC", "0.65"))
MIN_EXTRACTED_CHARS = 50


def normalize_extracted_text(raw: str) -> str:
    """
    Normalize document text for TTS: preserve paragraph breaks, fix line-break
    hyphenation, and strip common page-number noise. Mirrors src/lib/text-extraction.ts.
    """
    text = raw.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text)
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    text = re.sub(r"(?im)^\s*page\s+\d{1,4}(\s+of\s+\d{1,4})?\s*$", "", text)
    text = re.sub(r"^\s*[-–—]\s*\d{1,4}\s*[-–—]\s*$", "", text, flags=re.MULTILINE)
    text = re.sub(r"\n{3,}", "\n\n", text)

    paragraphs: list[str] = []
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = [line.strip() for line in block.split("\n") if line.strip()]
        if not lines:
            continue
        para = re.sub(r"[^\S\n]+", " ", " ".join(lines)).strip()
        if para:
            paragraphs.append(para)

    return "\n\n".join(paragraphs)


def _extract_text_from_pdf(pdf_path: str) -> str:
    import fitz

    doc = fitz.open(pdf_path)
    if doc.is_encrypted or doc.needs_pass:
        doc.close()
        raise ValueError("PDF is encrypted or password-protected")
    raw_text = "\n".join(page.get_text() for page in doc)
    doc.close()
    if not raw_text.strip():
        raise ValueError("Could not extract text from PDF")
    return normalize_extracted_text(raw_text)


def load_book_text(local_path: str) -> str:
    """Load normalized book text from a pre-extracted .txt or legacy PDF."""
    lower = local_path.lower()
    if lower.endswith(".txt"):
        with open(local_path, encoding="utf-8") as f:
            text = f.read()
        if not text.strip():
            raise ValueError("Text file is empty")
        return normalize_extracted_text(text)
    if lower.endswith(".pdf"):
        return _extract_text_from_pdf(local_path)
    raise ValueError(f"Unsupported document format: {local_path}")


def download_and_load_book_text(
    r2_client,
    bucket: str,
    storage_key: str,
    temp_dir: str,
) -> str:
    """
    Load book text for TTS. Prefers pre-extracted content.txt (upload-time
    ingestion). Falls back to legacy PDF extraction for older jobs.
    """
    basename = os.path.basename(storage_key) or "document"
    local_path = os.path.join(temp_dir, basename)
    download_from_r2(r2_client, bucket, storage_key, local_path)

    if storage_key.endswith(".txt"):
        text = load_book_text(local_path)
    else:
        companion_key = f"{storage_key.rsplit('/', 1)[0]}/content.txt"
        companion_local = os.path.join(temp_dir, "content.txt")
        try:
            download_from_r2(r2_client, bucket, companion_key, companion_local)
            text = load_book_text(companion_local)
        except Exception:
            text = load_book_text(local_path)

    if len(text.strip()) < MIN_EXTRACTED_CHARS:
        raise ValueError(
            "Could not extract enough text from document. "
            "It may be scanned, image-based, or DRM-protected."
        )
    return text


def normalize_punctuation(text: str) -> str:
    text = re.sub(r"!{2,}", "!", text)
    text = re.sub(r"\?{2,}", "?", text)
    text = re.sub(r"[?!]{2,}", "?", text)

    def fix_all_caps(match):
        word = match.group(0)
        return word.title() if len(word) >= 5 else word

    text = re.sub(r"\b[A-Z]{5,}\b", fix_all_caps, text)
    text = re.sub(r"(\S)—(\S)", r"\1 — \2", text)
    text = re.sub(r"(\S)--(\S)", r"\1 -- \2", text)
    text = re.sub(r"\.{3,}", "…", text)
    return text


def normalize_text(text: str) -> str:
    from num2words import num2words

    abbreviations = {
        r"\bDr\.\b": "Doctor",
        r"\bMr\.\b": "Mister",
        r"\bMrs\.\b": "Missus",
        r"\bMs\.\b": "Miss",
        r"\bSt\.\b": "Saint",
        r"\betc\.\b": "et cetera",
        r"\bi\.e\.\b": "that is",
        r"\be\.g\.\b": "for example",
    }
    for pattern, replacement in abbreviations.items():
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)

    def large_number_to_words(match):
        try:
            return num2words(int(match.group(0).replace(",", "")))
        except Exception:
            return match.group(0)

    text = re.sub(r"\b\d{1,3}(?:,\d{3})+\b", large_number_to_words, text)

    def number_to_words(match):
        num = int(match.group(0))
        if num > 20:
            try:
                return num2words(num)
            except Exception:
                return match.group(0)
        return match.group(0)

    text = re.sub(r"\b\d{2,}\b", number_to_words, text)
    return text


def split_text_into_paragraphs(text: str, max_chars: int = MAX_PARAGRAPH_CHARS) -> List[str]:
    raw_paragraphs = re.split(r"\n\s*\n", text.strip())
    paragraphs = []

    for para in raw_paragraphs:
        para = para.strip()
        if not para:
            continue
        if len(para) <= max_chars:
            paragraphs.append(para)
            continue

        sentences = re.split(r"(?<=[.!?])\s+", para)
        current: list[str] = []
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
                if current:
                    paragraphs.append(" ".join(current))
                if sent_len > max_chars:
                    words = sentence.split()
                    current = []
                    current_len = 0
                    for word in words:
                        if current_len + len(word) + 1 <= max_chars:
                            current.append(word)
                            current_len += len(word) + 1
                        else:
                            if current:
                                paragraphs.append(" ".join(current))
                            current = [word]
                            current_len = len(word)
                else:
                    current = [sentence]
                    current_len = sent_len
        if current:
            paragraphs.append(" ".join(current))

    return [p for p in paragraphs if p.strip()]


def split_text_into_sentence_units(
    text: str,
    max_chars: int = 700,
) -> list[dict]:
    """Create deterministic sentence-reset units while preserving paragraphs."""
    units: list[dict] = []
    abbreviations = re.compile(
        r"\b(?:Mr|Mrs|Ms|Dr|Prof|St|Sr|Jr|vs|etc)\.$",
        flags=re.IGNORECASE,
    )
    boundary = re.compile(r"(?<=[.!?])\s+(?=[A-Z\"'])")
    for paragraph_index, paragraph in enumerate(
        re.split(r"\n\s*\n", text.strip())
    ):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        sentences: list[str] = []
        for part in boundary.split(paragraph):
            part = part.strip()
            if not part:
                continue
            if sentences and abbreviations.search(sentences[-1]):
                sentences[-1] = f"{sentences[-1]} {part}"
            else:
                sentences.append(part)
        for sentence in sentences:
            fragments = [sentence]
            if len(sentence) > max_chars:
                fragments = []
                current = ""
                for clause in re.split(r"(?<=[,;:—])\s+", sentence):
                    if current and len(current) + len(clause) + 1 > max_chars:
                        fragments.append(current)
                        current = clause
                    else:
                        current = f"{current} {clause}".strip()
                if current:
                    fragments.append(current)
            for fragment in fragments:
                if len(fragment) <= max_chars:
                    units.append(
                        {
                            "text": fragment,
                            "paragraph_index": paragraph_index,
                            "ends_paragraph": False,
                        }
                    )
                    continue
                words = fragment.split()
                current_words: list[str] = []
                for word in words:
                    candidate = " ".join([*current_words, word])
                    if current_words and len(candidate) > max_chars:
                        units.append(
                            {
                                "text": " ".join(current_words),
                                "paragraph_index": paragraph_index,
                                "ends_paragraph": False,
                            }
                        )
                        current_words = [word]
                    else:
                        current_words.append(word)
                if current_words:
                    units.append(
                        {
                            "text": " ".join(current_words),
                            "paragraph_index": paragraph_index,
                            "ends_paragraph": False,
                        }
                    )
        if units:
            units[-1]["ends_paragraph"] = True
    return units


def partition_contiguous_paragraphs(
    paragraphs: list[dict],
    max_chunks: int,
    min_chunk_chars: int,
) -> list[list[dict]]:
    """
    Split ordered paragraphs into a bounded number of character-balanced chunks.

    Each chunk can be synthesized as its own strict continuation chain. Keeping
    chunks contiguous limits fresh-clone seams while allowing parallel GPUs.
    """
    items = [p for p in paragraphs if p.get("text", "").strip()]
    if not items:
        return []

    total_chars = sum(len(p.get("text", "")) for p in items)
    safe_min_chars = max(1, min_chunk_chars)
    desired_chunks = min(
        max(1, max_chunks),
        len(items),
        max(1, math.ceil(total_chars / safe_min_chars)),
    )
    if desired_chunks == 1:
        return [items]

    chunks: list[list[dict]] = []
    current: list[dict] = []
    current_chars = 0
    remaining_chars = total_chars
    remaining_chunks = desired_chunks

    for index, paragraph in enumerate(items):
        current.append(paragraph)
        current_chars += len(paragraph.get("text", ""))
        remaining_items = len(items) - index - 1
        target_chars = remaining_chars / remaining_chunks

        if (
            len(chunks) < desired_chunks - 1
            and current_chars >= target_chars
            and remaining_items >= remaining_chunks - 1
        ):
            chunks.append(current)
            remaining_chars -= current_chars
            remaining_chunks -= 1
            current = []
            current_chars = 0

    if current:
        chunks.append(current)

    return chunks


def get_r2_client():
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


def verify_r2_permissions(client, bucket: str) -> bool:
    try:
        client.list_objects_v2(Bucket=bucket, MaxKeys=1)
        return True
    except Exception as e:
        print(f"[R2] Permission check failed: {e}")
        return False


def download_from_r2(client, bucket: str, key: str, local_path: str):
    try:
        response = client.get_object(Bucket=bucket, Key=key)
        with open(local_path, "wb") as f:
            f.write(response["Body"].read())
    except Exception as e:
        print(f"[R2] get_object failed for {bucket}/{key}: {e}")
        client.download_file(bucket, key, local_path)


def upload_to_r2(client, bucket: str, key: str, local_path: str, content_type: str = "application/octet-stream"):
    client.upload_file(local_path, bucket, key, ExtraArgs={"ContentType": content_type})


def transcribe_with_whisper(audio_path: str, language: str = "en", model_size: str = "small") -> str:
    """Transcribe reference audio for Qwen ICL voice cloning (accuracy matters)."""
    from faster_whisper import WhisperModel

    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, _ = model.transcribe(
        audio_path,
        language=language,
        beam_size=5,
        vad_filter=True,
        word_timestamps=False,
    )
    return " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()


def canonicalize_reference_audio_ffmpeg(
    input_path: str,
    output_path: str,
    start_time: float = 0,
    duration: float | None = None,
    sample_rate: int = 24000,
):
    """Convert any ffmpeg-supported source into model-ready PCM16 mono WAV."""
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        input_path,
        "-ss",
        str(start_time),
    ]
    if duration is not None:
        cmd.extend(["-t", str(duration)])
    cmd.extend(
        [
            "-vn",
            "-map_metadata",
            "-1",
            "-ac",
            "1",
            "-af",
            f"aresample={sample_rate}:resampler=soxr:precision=28",
            "-ar",
            str(sample_rate),
            "-c:a",
            "pcm_s16le",
            output_path,
        ]
    )
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def clip_audio_ffmpeg(
    input_path: str,
    output_path: str,
    start_time: float,
    duration: float,
    sample_rate: int = 24000,
):
    canonicalize_reference_audio_ffmpeg(
        input_path,
        output_path,
        start_time=start_time,
        duration=duration,
        sample_rate=sample_rate,
    )


def _measure_rms(audio, start: int, num_samples: int) -> float:
    import numpy as np

    if num_samples <= 0 or start >= len(audio):
        return 0.0
    end = min(len(audio), start + num_samples)
    chunk = audio[start:end]
    if len(chunk) == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(chunk))))


def _cosine_gain_ramp(length: int, start_gain: float, end_gain: float = 1.0):
    import numpy as np

    if length <= 0:
        return np.array([], dtype=np.float32)
    t = np.linspace(0.0, 1.0, length, dtype=np.float32)
    return start_gain + (end_gain - start_gain) * (1.0 - np.cos(np.pi * t)) / 2.0


def smooth_batch_boundaries(
    audio_files: List[str],
    sample_rate: int = 24000,
) -> List[str]:
    """
    Tame energy spikes where independent synthesis batches meet.

    Each continuation batch gets a short opening gain ramp. When the new batch
    starts noticeably louder than the tail of the previous one, the ramp begins
    lower and eases up over ~0.5s so the handoff does not feel like a restart.
    """
    if os.environ.get("BATCH_SEAM_SMOOTHING", "1").lower() in {"0", "false", "no", "off"}:
        return audio_files
    if len(audio_files) < 2:
        return audio_files

    import numpy as np
    import soundfile as sf

    tail_window_sec = float(os.environ.get("BATCH_SEAM_TAIL_SEC", "0.75"))
    head_window_sec = float(os.environ.get("BATCH_SEAM_HEAD_SEC", "0.4"))
    ramp_duration_sec = float(os.environ.get("BATCH_SEAM_RAMP_SEC", "0.55"))
    subtle_fade_in_sec = float(os.environ.get("BATCH_SEAM_FADE_IN_SEC", "0.25"))
    max_atten_db = float(os.environ.get("BATCH_SEAM_MAX_ATTEN_DB", "4.0"))
    trigger_ratio = float(os.environ.get("BATCH_SEAM_TRIGGER_RATIO", "1.06"))
    subtle_start_gain = float(os.environ.get("BATCH_SEAM_SUBTLE_GAIN", "0.9"))
    min_gain = 10 ** (-max_atten_db / 20.0)

    prev_audio = None
    for idx, path in enumerate(audio_files):
        audio, sr = sf.read(path, dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        if sr != sample_rate:
            print(f"[SeamSmooth] Skipping {path}: expected {sample_rate} Hz, got {sr}")
            prev_audio = audio
            continue

        if idx > 0 and subtle_fade_in_sec > 0:
            fade_samples = min(len(audio), int(subtle_fade_in_sec * sr))
            if fade_samples > 1:
                audio[:fade_samples] *= _cosine_gain_ramp(
                    fade_samples, subtle_start_gain, 1.0
                )

        if idx > 0 and prev_audio is not None:
            tail_samples = int(tail_window_sec * sr)
            head_samples = int(head_window_sec * sr)
            tail_rms = _measure_rms(
                prev_audio, max(0, len(prev_audio) - tail_samples), tail_samples
            )
            head_rms = _measure_rms(audio, 0, head_samples)
            if tail_rms > 1e-6 and head_rms > tail_rms * trigger_ratio:
                start_gain = max(min_gain, tail_rms / head_rms)
                ramp_samples = min(len(audio), int(ramp_duration_sec * sr))
                if ramp_samples > 1 and start_gain < 0.995:
                    audio[:ramp_samples] *= _cosine_gain_ramp(
                        ramp_samples, start_gain, 1.0
                    )
                    print(
                        f"[SeamSmooth] Batch {idx}: head {head_rms:.4f} > tail {tail_rms:.4f}, "
                        f"opening gain {start_gain:.3f}"
                    )

        sf.write(path, audio, sr, subtype="PCM_16")
        prev_audio = audio

    return audio_files


def batch_seam_crossfade_duration(default: float = 0.12) -> float:
    return float(os.environ.get("BATCH_SEAM_CROSSFADE_SEC", str(default)))


def concatenate_audio_ffmpeg(audio_files: List[str], output_path: str, crossfade_duration: float = 0.05):
    if not audio_files:
        raise ValueError("No audio files to concatenate")
    if len(audio_files) == 1:
        shutil.copy(audio_files[0], output_path)
        return

    if len(audio_files) == 2:
        cmd = [
            "ffmpeg", "-y", "-i", audio_files[0], "-i", audio_files[1],
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
        output_label = f"a{len(audio_files)-2:02d}"
        cmd = ["ffmpeg", "-y"] + inputs + ["-filter_complex", ";".join(filter_parts), "-map", f"[{output_label}]", output_path]

    subprocess.run(cmd, check=True, capture_output=True, text=True)


def normalize_audio_ffmpeg(input_path: str, output_path: str, sample_rate: int = 24000):
    cmd = [
        "ffmpeg", "-y", "-i", input_path,
        "-af",
        "acompressor=threshold=-20dB:ratio=3:attack=5:release=100,"
        "equalizer=f=3000:width_type=h:width=200:g=2,"
        "highpass=f=80,"
        "loudnorm=I=-16:TP=-1.5:LRA=11,"
        "alimiter=level_in=1:level_out=1:limit=0.95",
        "-ar", str(sample_rate), "-b:a", "192k", output_path,
    ]
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def insert_silence_between_chunks(audio_files: List[str], output_path: str, silence_duration: float = PARAGRAPH_SILENCE):
    if not audio_files:
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


def send_webhook_sync(url: str, payload: dict, max_retries: int = 3) -> bool:
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
    return False


def send_webhook_async(url: str, payload: dict):
    def _send():
        try:
            send_webhook_sync(url, payload)
        except Exception as e:
            print(f"[Webhook Async] Failed: {e}")

    threading.Thread(target=_send, daemon=True).start()


def decode_audio_base64(audio_base64: str) -> tuple:
    import soundfile as sf

    audio_bytes = base64.b64decode(audio_base64)
    audio_io = io.BytesIO(audio_bytes)
    audio, sr = sf.read(audio_io, dtype="float32")
    if len(audio.shape) > 1:
        audio = audio.mean(axis=1)
    return audio.astype("float32", copy=False), sr