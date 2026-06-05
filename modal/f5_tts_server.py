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
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg", "libsndfile1", "espeak-ng", "libespeak-ng1",
                 "libavcodec-dev", "libavformat-dev", "libavutil-dev",
                 "libswscale-dev", "libswresample-dev")
    .pip_install(
        "torch==2.5.1",
        "torchaudio==2.5.1",
        "transformers<4.49",
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


def split_text_into_sections(text: str, max_chunk_size: int = 4000) -> List[str]:
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
    secrets=[modal.Secret.from_name("echomancer-secrets")],
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


# ── GPU: Audiobook Chunk Worker (parallel, keep_warm) ─────────────────────

@app.cls(
    gpu=GPU_CONFIG,
    scaledown_window=600,
    timeout=600,
    volumes={"/cache": volume},
    max_containers=4,
    secrets=[modal.Secret.from_name("echomancer-secrets")],
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
        Process a group of text sections into a single audio chunk.
        Returns dict with status; errors are caught internally so .map() never aborts.
        """
        import torch
        import soundfile as sf

        job_id = request_dict.get("job_id", "unknown")
        chunk_index = request_dict.get("chunk_index", 0)
        sections = request_dict.get("sections", [])
        voice_base64 = request_dict.get("voice_base64", "")
        webhook_url = request_dict.get("webhook_url", "")
        total_sections_global = request_dict.get("total_sections", len(sections))
        r2_bucket = request_dict.get("r2_bucket_name", "echomancer-audio")

        if not sections:
            return {"status": "error", "error": "No sections provided", "chunk_index": chunk_index}

        temp_dir = tempfile.mkdtemp(prefix=f"echomancer_{job_id}_chunk{chunk_index}_")
        start_time = time.time()

        try:
            # Decode reference audio once
            ref_audio, ref_sr = _decode_audio_for_worker(voice_base64)
            max_samples = int(15 * ref_sr)
            if len(ref_audio) > max_samples:
                start = (len(ref_audio) - max_samples) // 2
                ref_audio = ref_audio[start:start + max_samples]

            ref_path = os.path.join(temp_dir, "ref.wav")
            sf.write(ref_path, ref_audio, ref_sr)

            # Generate each section
            section_files = []
            failed_local = []

            for i, text in enumerate(sections):
                try:
                    with torch.inference_mode():
                        wav, sr, _ = self.model.infer(
                            ref_file=ref_path,
                            ref_text="",
                            gen_text=text,
                            nfe_step=32,
                            cfg_strength=2.0,
                            speed=1.0,
                        )
                    section_path = os.path.join(temp_dir, f"section_{i:04d}.wav")
                    sf.write(section_path, wav, sr, format="WAV")
                    section_files.append(section_path)
                except Exception as e:
                    print(f"[Worker {job_id}] Section {i} failed: {e}")
                    failed_local.append(i)

            if not section_files:
                return {"status": "error", "error": "All sections failed", "chunk_index": chunk_index}

            # Concatenate sections into one chunk audio
            chunk_audio_path = os.path.join(temp_dir, f"chunk_{chunk_index}.wav")
            concatenate_audio_ffmpeg(section_files, chunk_audio_path)

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
            print(f"[Worker {job_id}] Chunk {chunk_index} done: {len(section_files)}/{len(sections)} sections, {duration:.1f}s audio, {elapsed:.1f}s wall")

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
                "sections_done": len(section_files),
                "sections_failed": len(failed_local),
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
    secrets=[modal.Secret.from_name("echomancer-secrets")],
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

        # ── Step 1: Download PDF and extract text ─────────────────────
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

        with open(voice_clipped_path, "rb") as f:
            voice_bytes = f.read()
        voice_base64 = base64.b64encode(voice_bytes).decode("utf-8")
        print(f"[Job {job_id}] Voice sample ready ({clip_duration}s)")

        # ── Step 4: Split text into sections ──────────────────────────
        sections = split_text_into_sections(text, max_chunk_size=2000)
        total_sections = len(sections)
        print(f"[Job {job_id}] Split into {total_sections} sections (max_chunk_size=2000)")

        if total_sections == 0:
            raise ValueError("No text sections found")

        # ── Step 5: Decide parallelism ────────────────────────────────
        # Split into 4 chunks to saturate 4 warm GPU containers
        NUM_CHUNKS = 4
        sections_per_chunk = max(1, (total_sections + NUM_CHUNKS - 1) // NUM_CHUNKS)

        chunk_requests = []
        for chunk_idx in range(NUM_CHUNKS):
            start = chunk_idx * sections_per_chunk
            end = min(start + sections_per_chunk, total_sections)
            chunk_sections = sections[start:end]
            if not chunk_sections:
                continue
            chunk_requests.append({
                "job_id": job_id,
                "chunk_index": chunk_idx,
                "sections": chunk_sections,
                "voice_base64": voice_base64,
                "webhook_url": request.webhook_url,
                "total_sections": total_sections,
                "total_chunks": len(chunk_requests) + 1,  # approximate, refined below
                "r2_bucket_name": request.r2_bucket_name,
            })

        # Fix total_chunks count after we know it
        total_chunks = len(chunk_requests)
        for cr in chunk_requests:
            cr["total_chunks"] = total_chunks

        print(f"[Job {job_id}] Farming {total_chunks} chunks to {len(chunk_requests)} workers via .map()")

        send_webhook_async(request.webhook_url, {
            "job_id": job_id,
            "status": "processing",
            "progress": 10,
            "current_section": 0,
            "total_sections": total_sections,
            "message": f"Starting parallel generation with {total_chunks} chunks",
        })

        # ── Step 6: Parallel generation via .map() ────────────────────
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

        # ── Step 7: Download partials and concatenate ─────────────────
        print(f"[Job {job_id}] Step 7: Downloading {len(successful_chunks)} partial audios...")
        partial_files = []
        for chunk in successful_chunks:
            local_path = os.path.join(temp_dir, f"partial_{chunk['chunk_index']:03d}.wav")
            download_from_r2(r2, request.r2_bucket_name, chunk["r2_key"], local_path)
            partial_files.append(local_path)

        concatenated_path = os.path.join(temp_dir, "concatenated.wav")
        concatenate_audio_ffmpeg(partial_files, concatenated_path)

        # ── Step 8: Normalize and convert to MP3 ─────────────────────
        print(f"[Job {job_id}] Step 8: Post-processing...")
        final_path = os.path.join(temp_dir, "audiobook.mp3")
        normalize_audio_ffmpeg(concatenated_path, final_path)

        # ── Step 9: Upload to R2 ─────────────────────────────────────
        print(f"[Job {job_id}] Step 9: Uploading to R2...")
        output_key = f"audiobooks/{job_id}/audiobook.mp3"
        upload_to_r2(r2, request.r2_bucket_name, output_key, final_path, "audio/mpeg")

        file_size = os.path.getsize(final_path)
        estimated_duration = int(file_size / 24000)

        print(f"[Job {job_id}] Complete! Uploaded to {output_key} ({file_size} bytes, ~{estimated_duration}s audio)")

        # Clean up partial chunk files from R2
        for chunk in successful_chunks:
            try:
                r2.delete_object(Bucket=request.r2_bucket_name, Key=chunk["r2_key"])
            except Exception as e:
                print(f"[Job {job_id}] Failed to delete partial chunk {chunk['r2_key']}: {e}")

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
    allow_origins=["https://echomancer-v2.vercel.app"],
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
                speed=request.get("speed", 1.0),
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
