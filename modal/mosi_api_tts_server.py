"""
MOSI Studio API TTS Server for Echomancer — same MOSS-TTS (MossTTSDelay-8B family)
model as modal/moss_tts_server.py, but served by the official hosted API at
https://studio.mosi.cn instead of self-hosted GPUs.

The Modal app stays as a thin CPU-only orchestrator (PDF extraction, voice
clipping/cleaning, R2, webhooks) and every synthesis call goes to the MOSI API:
  POST /api/v1/files/upload      — upload reference audio
  POST /api/v1/voice/clone       — register a cloned voice → voice_id
  GET  /api/v1/voices            — poll clone status (ACTIVE)
  POST /api/v1/audio/speech      — synthesize (model=moss-tts, base64 24 kHz WAV)

Deploy:
  modal deploy modal/mosi_api_tts_server.py

Modal secret (add to echomancer-secrets):
  MOSI_TTS_API_KEY=sk-...   # from https://studio.mosi.cn → console → API keys

Set Vercel env:
  TTS_PIPELINE_MODE=moss
  MOSS_AB_VARIANT=api
  MODAL_MOSS_API_TTS_URL=https://<user>--echomancer-mosi-api-tts-fastapi-app.modal.run/generate_batch
  MODAL_TTS_URL=<same URL>  # voice preview + warmup

Optional Modal env:
  MOSI_API_BASE_URL (default https://studio.mosi.cn)
  MOSI_API_CONCURRENCY (default 2)
  MOSI_BATCH_CHARS (default 1000)

Rollback: MOSS_AB_VARIANT=delay|local with the existing self-hosted Modal apps.
"""

from __future__ import annotations

import base64
import os
import re
import shutil
import tempfile
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import modal

from emotion_instruct import analyze_paragraph
from tts_shared import (
    MAX_PARAGRAPH_CHARS,
    PARAGRAPH_SILENCE,
    clip_audio_ffmpeg,
    concatenate_audio_ffmpeg,
    download_from_r2,
    get_r2_client,
    normalize_audio_ffmpeg,
    normalize_punctuation,
    normalize_text,
    send_webhook_async,
    send_webhook_sync,
    split_text_into_paragraphs,
    upload_to_r2,
    verify_r2_permissions,
)

APP_NAME = "echomancer-mosi-api-tts"
MOSI_MODEL = "moss-tts"
MOSI_LABEL = "MOSI-API (moss-tts)"
OUTPUT_SAMPLE_RATE = 24000
MAX_REF_SECONDS = 30  # MOSI clone guidance: 10-30s clean reference
DEFAULT_LANGUAGE = "English"

MOSI_API_BASE_URL = os.environ.get("MOSI_API_BASE_URL", "https://studio.mosi.cn").rstrip("/")
MOSI_API_CONCURRENCY = int(os.environ.get("MOSI_API_CONCURRENCY", "2"))
# Smaller than the self-hosted batches: hosted endpoint rejects overly long text (code 5004).
MOSI_BATCH_CHARS = int(os.environ.get("MOSI_BATCH_CHARS", "1000"))
MOSI_MAX_NEW_TOKENS = int(os.environ.get("MOSI_MAX_NEW_TOKENS", "4096"))
MOSI_TEMPERATURE = float(os.environ.get("MOSI_TEMPERATURE", "1.5"))  # English default
MOSI_CLONE_TIMEOUT_SECONDS = 120
MOSI_SPEECH_TIMEOUT_SECONDS = 300

cpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg", "libsndfile1")
    .pip_install(
        "fastapi",
        "uvicorn",
        "boto3",
        "httpx",
        "pymupdf",
        "num2words",
        "soundfile",
        "numpy<2",
    )
    .add_local_python_source("emotion_instruct")
    .add_local_python_source("tts_shared")
)

app = modal.App(APP_NAME)


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
    pipeline_mode: str = "moss"
    moss_language: str = DEFAULT_LANGUAGE


class MosiApiError(Exception):
    def __init__(self, message: str, code: int | None = None):
        super().__init__(message)
        self.code = code


def _api_key() -> str:
    key = os.environ.get("MOSI_TTS_API_KEY", "")
    if not key:
        raise MosiApiError("MOSI_TTS_API_KEY not set — add it to the echomancer-secrets Modal secret")
    return key


def _headers() -> dict:
    return {"Authorization": f"Bearer {_api_key()}"}


def _raise_for_api_error(payload: dict) -> None:
    code = payload.get("code")
    if isinstance(code, int) and code >= 4000:
        raise MosiApiError(payload.get("message") or f"MOSI API error {code}", code=code)


def _post_json(client, path: str, payload: dict, timeout: float) -> dict:
    """POST with retry on rate limiting (code 4029 / HTTP 429)."""
    url = f"{MOSI_API_BASE_URL}{path}"
    delay = 2.0
    for attempt in range(5):
        response = client.post(
            url,
            json=payload,
            headers={**_headers(), "Content-Type": "application/json"},
            timeout=timeout,
        )
        if response.status_code == 429:
            time.sleep(delay)
            delay = min(delay * 2, 30)
            continue
        response.raise_for_status()
        data = response.json()
        if isinstance(data, dict) and data.get("code") == 4029:
            time.sleep(delay)
            delay = min(delay * 2, 30)
            continue
        if isinstance(data, dict):
            _raise_for_api_error(data)
        return data
    raise MosiApiError("MOSI API rate limited after retries", code=4029)


def _upload_reference(client, wav_path: str) -> str:
    with open(wav_path, "rb") as f:
        response = client.post(
            f"{MOSI_API_BASE_URL}/api/v1/files/upload",
            files={"file": ("reference.wav", f, "audio/wav")},
            headers=_headers(),
            timeout=120.0,
        )
    response.raise_for_status()
    data = response.json()
    _raise_for_api_error(data)
    file_id = data.get("file_id") or (data.get("data") or {}).get("file_id")
    if not file_id:
        raise MosiApiError(f"Upload returned no file_id: {str(data)[:300]}")
    return file_id


def _clone_voice(client, file_id: str, name: str) -> str:
    data = _post_json(
        client,
        "/api/v1/voice/clone",
        {"file_id": file_id, "name": name[:60]},
        timeout=60.0,
    )
    voice_id = data.get("voice_id") or (data.get("data") or {}).get("voice_id")
    if not voice_id:
        raise MosiApiError(f"Clone returned no voice_id: {str(data)[:300]}")
    return voice_id


def _wait_voice_active(client, voice_id: str, timeout_seconds: float = MOSI_CLONE_TIMEOUT_SECONDS) -> None:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        response = client.get(f"{MOSI_API_BASE_URL}/api/v1/voices", headers=_headers(), timeout=30.0)
        response.raise_for_status()
        data = response.json()
        voices = data if isinstance(data, list) else data.get("voices") or data.get("data") or []
        for voice in voices:
            if voice.get("voice_id") == voice_id or voice.get("id") == voice_id:
                status = str(voice.get("status", "")).upper()
                if status == "ACTIVE":
                    return
                if status in {"FAILED", "REJECTED"}:
                    raise MosiApiError(f"Voice clone {voice_id} status={status}")
        time.sleep(3)
    raise MosiApiError(f"Voice clone {voice_id} not ACTIVE after {timeout_seconds:.0f}s")


def register_cloned_voice(client, wav_path: str, name: str) -> str:
    file_id = _upload_reference(client, wav_path)
    voice_id = _clone_voice(client, file_id, name)
    _wait_voice_active(client, voice_id)
    return voice_id


def _speech_request(client, text: str, voice_id: str) -> bytes:
    data = _post_json(
        client,
        "/api/v1/audio/speech",
        {
            "model": MOSI_MODEL,
            "text": text,
            "voice_id": voice_id,
            "sampling_params": {
                "temperature": MOSI_TEMPERATURE,
                "max_new_tokens": MOSI_MAX_NEW_TOKENS,
            },
        },
        timeout=MOSI_SPEECH_TIMEOUT_SECONDS,
    )
    audio_b64 = (
        data.get("audio_base64")
        or data.get("audio")
        or (data.get("data") or {}).get("audio_base64")
        or (data.get("data") or {}).get("audio")
    )
    if not audio_b64:
        raise MosiApiError(f"Speech returned no audio: {str(data)[:300]}")
    return base64.b64decode(audio_b64)


def synthesize_text(client, text: str, voice_id: str) -> bytes:
    """Synthesize text, halving on 'text too long' (code 5004) responses."""
    try:
        return _speech_request(client, text, voice_id)
    except MosiApiError as e:
        if e.code != 5004 or len(text) < 200:
            raise
    midpoint = len(text) // 2
    split_at = text.rfind(" ", 0, midpoint)
    if split_at <= 0:
        split_at = midpoint
    first = synthesize_text(client, text[:split_at].strip(), voice_id)
    second = synthesize_text(client, text[split_at:].strip(), voice_id)
    temp_dir = tempfile.mkdtemp(prefix="mosi_split_")
    try:
        first_path = os.path.join(temp_dir, "a.wav")
        second_path = os.path.join(temp_dir, "b.wav")
        joined_path = os.path.join(temp_dir, "joined.wav")
        with open(first_path, "wb") as f:
            f.write(first)
        with open(second_path, "wb") as f:
            f.write(second)
        concatenate_audio_ffmpeg([first_path, second_path], joined_path)
        with open(joined_path, "rb") as f:
            return f.read()
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def apply_moss_pacing(text: str) -> str:
    """Add explicit pause markers for deliberately paced passages."""
    speed, _ = analyze_paragraph(text)
    if speed >= 0.85:
        return text
    paced = re.sub(r" — ", " — [pause 0.4s] ", text)
    paced = re.sub(r"; ", "; [pause 0.3s] ", paced)
    return paced


def _group_paragraphs_for_synthesis(
    paragraphs: list[dict],
    max_chars: int = MOSI_BATCH_CHARS,
) -> list[list[dict]]:
    batches: list[list[dict]] = []
    current: list[dict] = []
    current_len = 0
    for para in paragraphs:
        text = para.get("text", "").strip()
        if not text:
            continue
        if current and current_len + len(text) > max_chars:
            batches.append(current)
            current = []
            current_len = 0
        current.append(para)
        current_len += len(text)
    if current:
        batches.append(current)
    return batches


def _join_batch_text(paragraphs: list[dict]) -> str:
    parts = [
        apply_moss_pacing(p.get("text", "").strip())
        for p in paragraphs
        if p.get("text", "").strip()
    ]
    return f" [pause {PARAGRAPH_SILENCE}s] ".join(parts)


# ── CPU orchestrator ─────────────────────────────────────────────────────────

@app.function(
    image=cpu_image,
    timeout=3600,
    secrets=[modal.Secret.from_name("echomancer-secrets")],
)
def process_audiobook(request_dict: dict) -> dict:
    import fitz
    import httpx

    job_id = request_dict.get("job_id", "unknown")
    print(f"[MOSI Job {job_id}] Orchestrator STARTED")
    request = AudiobookRequest(**request_dict)
    temp_dir = tempfile.mkdtemp(prefix=f"mosi_{job_id}_")

    try:
        r2 = get_r2_client()
        if not verify_r2_permissions(r2, request.r2_bucket_name):
            raise ValueError("R2 permissions check failed")

        pdf_path = os.path.join(temp_dir, "input.pdf")
        download_from_r2(r2, request.r2_bucket_name, request.pdf_r2_key, pdf_path)

        doc = fitz.open(pdf_path)
        if doc.is_encrypted or doc.needs_pass:
            doc.close()
            raise ValueError("PDF is encrypted or password-protected")
        raw_text = "".join(page.get_text() for page in doc)
        doc.close()
        if not raw_text.strip():
            raise ValueError("Could not extract text from PDF")

        text = re.sub(r"\s+", " ", raw_text).strip()
        print(f"[MOSI Job {job_id}] Extracted {len(text)} characters")

        voice_path = os.path.join(temp_dir, "voice_raw")
        download_from_r2(r2, request.r2_bucket_name, request.voice_r2_key, voice_path)

        clip_duration = max(3, min(MAX_REF_SECONDS, request.end_time - request.start_time))
        voice_clipped_path = os.path.join(temp_dir, "voice_clipped.wav")
        clip_audio_ffmpeg(
            voice_path,
            voice_clipped_path,
            request.start_time,
            clip_duration,
            sample_rate=OUTPUT_SAMPLE_RATE,
        )

        voice_final_path = voice_clipped_path
        audio_cleaner_url = os.environ.get("AUDIO_CLEANER_URL", "").rstrip("/")
        if audio_cleaner_url:
            try:
                with open(voice_clipped_path, "rb") as f:
                    voice_clipped_b64 = base64.b64encode(f.read()).decode("utf-8")
                with httpx.Client(timeout=60.0) as cleaner:
                    response = cleaner.post(
                        f"{audio_cleaner_url}/clean",
                        json={
                            "audio_base64": voice_clipped_b64,
                            "target_sample_rate": OUTPUT_SAMPLE_RATE,
                            "normalize_loudness": True,
                            "target_lufs": -16.0,
                        },
                    )
                if response.status_code == 200:
                    cleaned_b64 = response.json().get("audio_base64")
                    if cleaned_b64:
                        voice_cleaned_path = os.path.join(temp_dir, "voice_cleaned.wav")
                        with open(voice_cleaned_path, "wb") as f:
                            f.write(base64.b64decode(cleaned_b64))
                        voice_final_path = voice_cleaned_path
                        print(f"[MOSI Job {job_id}] Voice cleaned via Audio Cleaner")
            except Exception as e:
                print(f"[MOSI Job {job_id}] Audio Cleaner skipped: {e}")

        text = normalize_punctuation(normalize_text(text))
        paragraphs_raw = split_text_into_paragraphs(text, max_chars=MAX_PARAGRAPH_CHARS)
        paragraphs = [{"text": p} for p in paragraphs_raw]
        total_paragraphs = len(paragraphs)
        if total_paragraphs == 0:
            raise ValueError("No paragraphs found")

        batches = _group_paragraphs_for_synthesis(paragraphs)
        total_batches = len(batches)
        print(
            f"[MOSI Job {job_id}] {total_paragraphs} paragraphs, {total_batches} batches, "
            f"concurrency={MOSI_API_CONCURRENCY}, model={MOSI_MODEL}"
        )

        send_webhook_async(
            request.webhook_url,
            {
                "job_id": job_id,
                "status": "processing",
                "progress": 5,
                "current_paragraph": 0,
                "total_paragraphs": total_paragraphs,
                "message": f"Registering voice clone with {MOSI_LABEL}",
            },
        )

        with httpx.Client() as client:
            voice_id = register_cloned_voice(
                client, voice_final_path, f"echomancer-{job_id}"
            )
            print(f"[MOSI Job {job_id}] Voice clone ready: {voice_id}")

            send_webhook_async(
                request.webhook_url,
                {
                    "job_id": job_id,
                    "status": "processing",
                    "progress": 10,
                    "message": f"Starting {MOSI_LABEL} synthesis ({total_batches} batches)",
                },
            )

            batch_texts = [_join_batch_text(batch) for batch in batches]
            done_count = 0

            def synth_batch(idx_text: tuple[int, str]) -> tuple[int, bytes]:
                idx, batch_text = idx_text
                wav = synthesize_text(client, batch_text, voice_id)
                return idx, wav

            partial_files: list[str] = [""] * total_batches
            with ThreadPoolExecutor(max_workers=max(1, MOSI_API_CONCURRENCY)) as pool:
                for idx, wav_bytes in pool.map(synth_batch, enumerate(batch_texts)):
                    local_path = os.path.join(temp_dir, f"partial_{idx:04d}.wav")
                    with open(local_path, "wb") as f:
                        f.write(wav_bytes)
                    partial_files[idx] = local_path
                    done_count += 1
                    send_webhook_async(
                        request.webhook_url,
                        {
                            "job_id": job_id,
                            "status": "processing",
                            "progress": 10 + int(done_count / total_batches * 60),
                            "message": f"MOSI batch {done_count}/{total_batches} complete",
                        },
                    )

        missing = [i for i, p in enumerate(partial_files) if not p]
        if missing:
            raise ValueError(f"Batches {missing} failed")

        send_webhook_async(
            request.webhook_url,
            {
                "job_id": job_id,
                "status": "processing",
                "progress": 75,
                "message": "MOSI batches complete, concatenating...",
            },
        )

        concatenated_path = os.path.join(temp_dir, "concatenated.wav")
        concatenate_audio_ffmpeg(partial_files, concatenated_path)

        final_path = os.path.join(temp_dir, "audiobook.mp3")
        normalize_audio_ffmpeg(concatenated_path, final_path, sample_rate=OUTPUT_SAMPLE_RATE)

        output_key = f"audiobooks/{job_id}/audiobook.mp3"
        upload_to_r2(r2, request.r2_bucket_name, output_key, final_path, "audio/mpeg")

        file_size = os.path.getsize(final_path)
        estimated_duration = int(file_size / 24000)

        send_webhook_sync(
            request.webhook_url,
            {
                "job_id": job_id,
                "status": "ready",
                "progress": 100,
                "audio_storage_path": output_key,
                "duration_seconds": estimated_duration,
                "error_message": None,
            },
        )

        return {
            "status": "success",
            "audio_storage_path": output_key,
            "duration_seconds": estimated_duration,
            "pipeline_mode": "moss",
            "variant": "api",
        }

    except Exception as e:
        error_msg = str(e)
        print(f"[MOSI Job {job_id}] ERROR: {error_msg}")
        traceback.print_exc()
        send_webhook_sync(
            request.webhook_url,
            {
                "job_id": job_id,
                "status": "failed",
                "progress": 0,
                "error_message": error_msg,
            },
        )
        return {"status": "failed", "error": error_msg}
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


# ── FastAPI ──────────────────────────────────────────────────────────────────

@app.function(
    image=cpu_image,
    timeout=1800,
    secrets=[modal.Secret.from_name("echomancer-secrets")],
)
@modal.asgi_app()
def fastapi_app():
    from fastapi import FastAPI, HTTPException
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse

    web_app = FastAPI(title=f"Echomancer MOSS-TTS ({MOSI_LABEL})")
    web_app.add_middleware(
        CORSMiddleware,
        allow_origins=["https://echomancer-v2.vercel.app"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @web_app.get("/health")
    async def health() -> JSONResponse:
        return JSONResponse(
            {
                "status": "ok",
                "pipeline": "moss",
                "variant": "api",
                "model": MOSI_MODEL,
                "api_base_url": MOSI_API_BASE_URL,
                "concurrency": MOSI_API_CONCURRENCY,
                "batch_chars": MOSI_BATCH_CHARS,
                "api_key_configured": bool(os.environ.get("MOSI_TTS_API_KEY")),
                "timestamp": time.time(),
            }
        )

    @web_app.post("/warmup")
    async def warmup_endpoint(request: dict) -> JSONResponse:
        # Hosted API — no GPU containers to warm.
        return JSONResponse(
            {"status": "warm", "containers_ready": 0, "results": [], "variant": "api"}
        )

    @web_app.post("/generate_audiobook")
    async def generate_audiobook_endpoint(request: dict) -> JSONResponse:
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
                pipeline_mode=request.get("pipeline_mode", "moss"),
                moss_language=request.get("moss_language", DEFAULT_LANGUAGE),
            )
            call = await process_audiobook.spawn.aio(req.__dict__)
            return JSONResponse(
                {
                    "status": "accepted",
                    "job_id": req.job_id,
                    "pipeline_mode": "moss",
                    "variant": "api",
                    "model": MOSI_MODEL,
                    "call_id": call.object_id,
                }
            )
        except Exception as e:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=str(e))

    @web_app.post("/generate_batch")
    async def generate_batch_endpoint(request: dict) -> JSONResponse:
        """Voice preview — MOSI zero-shot clone from user reference audio."""
        import anyio

        try:
            texts = request.get("texts") or [request.get("text", "Hello, this is a voice preview.")]
            reference_audio_base64 = request["reference_audio_base64"]

            def run_preview() -> list[dict]:
                import httpx

                temp_dir = tempfile.mkdtemp(prefix="mosi_preview_")
                try:
                    ref_path = os.path.join(temp_dir, "ref.wav")
                    with open(ref_path, "wb") as f:
                        f.write(base64.b64decode(reference_audio_base64))
                    with httpx.Client() as client:
                        voice_id = register_cloned_voice(
                            client, ref_path, f"echomancer-preview-{int(time.time())}"
                        )
                        results = []
                        for text in texts:
                            try:
                                wav_bytes = synthesize_text(client, text, voice_id)
                                results.append(
                                    {
                                        "audio_base64": base64.b64encode(wav_bytes).decode("utf-8"),
                                        "error": None,
                                        "pipeline_path": "moss",
                                    }
                                )
                            except Exception as synth_err:
                                results.append(
                                    {
                                        "audio_base64": None,
                                        "error": str(synth_err),
                                        "pipeline_path": "failed",
                                    }
                                )
                        return results
                finally:
                    shutil.rmtree(temp_dir, ignore_errors=True)

            results = await anyio.to_thread.run_sync(run_preview)
            return JSONResponse(
                {
                    "results": results,
                    "pipeline_mode": "moss",
                    "variant": "api",
                    "model": MOSI_MODEL,
                }
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    return web_app
