"""
F5-TTS Server for Echomancer - Full Audiobook Pipeline

Architecture:
- fastapi_app     -> CPU-only web endpoint (instant cold start)
  - /generate_batch    -> Proxies to GPU container for voice preview
  - /generate_audiobook -> Spawns GPU worker, returns immediately
  - /health            -> Health check
- F5TTSServer     -> GPU container for voice preview
- process_audiobook -> GPU container for audiobook generation

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
from typing import List, Optional, Dict, Any
from dataclasses import dataclass, asdict
from contextlib import contextmanager

import modal

GPU_CONFIG = "A10G"

# Base image with ALL dependencies (used by both CPU and GPU functions)
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg", "libsndfile1", "espeak-ng", "libespeak-ng1")
    .pip_install(
        "torch==2.4.1",
        "torchaudio==2.4.1",
        "transformers",
        "accelerate",
        "huggingface-hub",
        "soundfile",
        "librosa",
        "pydub",
        "numpy<2",
        "boto3",
        "httpx",
        "pymupdf",
        "git+https://github.com/SWivid/F5-TTS.git",
    )
)

volume = modal.Volume.from_name("f5-tts-cache-v2", create_if_missing=True)

app = modal.App("echomancer-f5-tts", image=image)


# ── Data Classes ──────────────────────────────────────────────────────────

@dataclass
class BatchTTSRequest:
    texts: List[str]
    reference_audio_base64: str
    reference_text: Optional[str] = None
    speed: float = 1.0
    cfg_strength: float = 2.0
    nfe_step: int = 32


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
    """Create boto3 S3 client for Cloudflare R2."""
    import boto3
    account_id = os.environ.get("R2_ACCOUNT_ID", "")
    access_key = os.environ.get("R2_ACCESS_KEY_ID", "")
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY", "")
    if not all([account_id, access_key, secret_key]):
        raise ValueError("R2 credentials not configured")
    return boto3.client(
        "s3",
        region_name="auto",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
    )


def download_from_r2(client, bucket: str, key: str, local_path: str):
    client.download_file(bucket, key, local_path)


def upload_to_r2(client, bucket: str, key: str, local_path: str, content_type: str = "application/octet-stream"):
    client.upload_file(local_path, bucket, key, ExtraArgs={"ContentType": content_type})


def split_text_into_sections(text: str, max_chunk_size: int = 1200) -> List[str]:
    """Split text into sentence-based chunks."""
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    sections = []
    current = []
    current_len = 0

    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue
        sent_len = len(sentence)
        if current_len + sent_len + 1 > max_chunk_size and current:
            sections.append(" ".join(current))
            current = [sentence]
            current_len = sent_len
        else:
            current.append(sentence)
            current_len += sent_len + 1

    if current:
        sections.append(" ".join(current))

    return sections


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
    cmd = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
        "-ar", str(sample_rate),
        "-b:a", "192k",
        output_path,
    ]
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def send_webhook_sync(url: str, payload: dict, max_retries: int = 3):
    """Send webhook synchronously with retries."""
    import httpx
    for attempt in range(max_retries):
        try:
            with httpx.Client(timeout=30.0) as client:
                response = client.post(url, json=payload)
                print(f"[Webhook] {url} -> {response.status_code}")
                if response.status_code < 500:
                    return True
        except Exception as e:
            print(f"[Webhook] Attempt {attempt + 1} failed: {e}")
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)
    print(f"[Webhook] All {max_retries} attempts failed")
    return False


# ── GPU: F5-TTS Server (for voice preview) ────────────────────────────────

@app.cls(
    gpu=GPU_CONFIG,
    scaledown_window=300,
    timeout=600,
    volumes={"/cache": volume},
    max_containers=1,
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


# ── GPU: Audiobook Worker (standalone) ────────────────────────────────────

@app.function(
    gpu=GPU_CONFIG,
    scaledown_window=300,
    timeout=3600,
    volumes={"/cache": volume},
)
def process_audiobook(request_dict: dict) -> dict:
    """
    Full audiobook generation pipeline.
    Runs as a standalone Modal function with its own GPU container.
    """
    import torch
    import soundfile as sf
    import fitz  # pymupdf
    from f5_tts.api import F5TTS

    request = AudiobookRequest(**request_dict)
    job_id = request.job_id
    temp_dir = tempfile.mkdtemp(prefix=f"echomancer_{job_id}_")

    def cleanup():
        try:
            shutil.rmtree(temp_dir, ignore_errors=True)
        except Exception:
            pass

    try:
        # Load F5-TTS model
        print(f"[Job {job_id}] Loading F5-TTS model...")
        os.makedirs("/cache/models", exist_ok=True)
        model = F5TTS(
            model="F5TTS_v1_Base",
            device="cuda",
            hf_cache_dir="/cache/models",
        )
        print(f"[Job {job_id}] Model loaded")

        # Initialize R2 client
        r2 = get_r2_client()

        # ── Step 1: Download PDF and extract text ─────────────────────
        print(f"[Job {job_id}] Step 1: Downloading PDF from R2...")
        pdf_path = os.path.join(temp_dir, "input.pdf")
        download_from_r2(r2, request.r2_bucket_name, request.pdf_r2_key, pdf_path)

        print(f"[Job {job_id}] Step 2: Extracting text from PDF...")
        doc = fitz.open(pdf_path)
        raw_text = ""
        for page in doc:
            raw_text += page.get_text()
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

        with open(voice_clipped_path, "rb") as f:
            voice_bytes = f.read()
        voice_base64 = base64.b64encode(voice_bytes).decode("utf-8")
        print(f"[Job {job_id}] Voice sample ready ({clip_duration}s, {len(voice_bytes)} bytes)")

        # ── Step 4: Split text into sections ──────────────────────────
        sections = split_text_into_sections(text, max_chunk_size=1200)
        total_sections = len(sections)
        print(f"[Job {job_id}] Split into {total_sections} sections")

        if total_sections == 0:
            raise ValueError("No text sections found")

        # Send initial progress
        send_webhook_sync(request.webhook_url, {
            "job_id": job_id,
            "status": "processing",
            "progress": 10,
            "current_section": 0,
            "total_sections": total_sections,
        })

        # ── Step 5: Generate audio in batches ─────────────────────────
        BATCH_SIZE = 8
        audio_files = []
        completed = 0
        batch_start_time = time.time()

        for batch_start in range(0, total_sections, BATCH_SIZE):
            batch_end = min(batch_start + BATCH_SIZE, total_sections)
            batch_texts = sections[batch_start:batch_end]
            batch_num = batch_start // BATCH_SIZE + 1
            total_batches = (total_sections - 1) // BATCH_SIZE + 1

            print(f"[Job {job_id}] Batch {batch_num}/{total_batches}: {len(batch_texts)} sections")

            # Decode reference audio once per batch
            ref_audio, ref_sr = _decode_audio_for_worker(voice_base64)
            max_samples = int(15 * ref_sr)
            if len(ref_audio) > max_samples:
                start = (len(ref_audio) - max_samples) // 2
                ref_audio = ref_audio[start:start + max_samples]

            with temp_audio_file(b"") as ref_path:
                sf.write(ref_path, ref_audio, ref_sr)

                for i, text in enumerate(batch_texts):
                    section_idx = batch_start + i
                    try:
                        with torch.inference_mode():
                            wav, sr, _ = model.infer(
                                ref_file=ref_path,
                                ref_text="",
                                gen_text=text,
                                nfe_step=32,
                                cfg_strength=2.0,
                                speed=1.0,
                            )

                        section_path = os.path.join(temp_dir, f"section_{section_idx:04d}.wav")
                        sf.write(section_path, wav, sr, format="WAV")
                        audio_files.append(section_path)
                        completed += 1
                        print(f"[Job {job_id}] Section {section_idx + 1}/{total_sections} done ({len(wav)/sr:.1f}s)")
                    except Exception as e:
                        print(f"[Job {job_id}] Section {section_idx + 1} failed: {e}")

            # Report progress
            progress = 10 + int((completed / total_sections) * 70)
            send_webhook_sync(request.webhook_url, {
                "job_id": job_id,
                "status": "processing",
                "progress": progress,
                "current_section": completed,
                "total_sections": total_sections,
            })

        if not audio_files:
            raise ValueError("No audio sections were successfully generated")

        batch_elapsed = time.time() - batch_start_time
        print(f"[Job {job_id}] All sections done in {batch_elapsed:.1f}s")

        # ── Step 6: Concatenate audio ─────────────────────────────────
        print(f"[Job {job_id}] Step 6: Concatenating {len(audio_files)} sections...")
        concatenated_path = os.path.join(temp_dir, "concatenated.wav")
        concatenate_audio_ffmpeg(audio_files, concatenated_path)

        # ── Step 7: Normalize and convert to MP3 ─────────────────────
        print(f"[Job {job_id}] Step 7: Post-processing...")
        final_path = os.path.join(temp_dir, "audiobook.mp3")
        normalize_audio_ffmpeg(concatenated_path, final_path)

        # ── Step 8: Upload to R2 ─────────────────────────────────────
        print(f"[Job {job_id}] Step 8: Uploading to R2...")
        output_key = f"audiobooks/{job_id}/audiobook.mp3"
        upload_to_r2(r2, request.r2_bucket_name, output_key, final_path, "audio/mpeg")

        file_size = os.path.getsize(final_path)
        estimated_duration = int(file_size / 24000)
        total_elapsed = time.time() - batch_start_time

        print(f"[Job {job_id}] Complete! Uploaded to {output_key} ({file_size} bytes, ~{estimated_duration}s audio, {total_elapsed:.1f}s total)")

        # Final webhook
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
        }

    except Exception as e:
        error_msg = str(e)
        traceback_str = traceback.format_exc()
        print(f"[Job {job_id}] ERROR: {error_msg}")
        print(traceback_str)
        send_webhook_sync(request.webhook_url, {
            "job_id": job_id,
            "status": "failed",
            "progress": 0,
            "error_message": error_msg,
        })
        return {"status": "failed", "error": error_msg}

    finally:
        cleanup()


def _decode_audio_for_worker(audio_base64: str) -> tuple:
    import soundfile as sf
    audio_bytes = base64.b64decode(audio_base64)
    audio_io = io.BytesIO(audio_bytes)
    audio, sr = sf.read(audio_io)
    if len(audio.shape) > 1:
        audio = audio.mean(axis=1)
    return audio, sr


# ── CPU: FastAPI Web Endpoint (instant cold start) ────────────────────────

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

web_app = FastAPI(title="Echomancer F5-TTS")

web_app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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

    @web_app.post("/generate_batch")
    async def generate_batch_endpoint(request: dict) -> JSONResponse:
        """Voice preview — proxies to GPU container."""
        try:
            server = F5TTSServer()
            batch_request = BatchTTSRequest(
                texts=request["texts"],
                reference_audio_base64=request["reference_audio_base64"],
                reference_text=request.get("reference_text"),
                speed=request.get("speed", 1.0),
                cfg_strength=request.get("cfg_strength", 2.0),
                nfe_step=request.get("nfe_step", 32),
            )
            result = await server.generate_batch.remote.aio(batch_request)
            return JSONResponse(content=result)
        except Exception as e:
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
            )
            process_audiobook.spawn(req.__dict__)
            return JSONResponse(content={
                "status": "accepted",
                "job_id": req.job_id,
                "message": "Audiobook generation started",
            })
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    return web_app
