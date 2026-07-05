"""
SGLang-Omni MOSS-TTS Server for Echomancer — same MOSS-TTS-v1.5 (MossTTSDelay-8B)
model as modal/moss_tts_server.py, served through SGLang-Omni's high-performance
pipeline (continuous batching, RadixAttention, CUDA graphs) instead of a raw
transformers loop.

Each GPU container runs `sgl-omni serve` locally and proxies requests to its
OpenAI-compatible `POST /v1/audio/speech` endpoint (voice cloning via
`ref_audio` + `ref_text`, WAV bytes response, 24 kHz output).

Deploy:
  modal deploy modal/sglang_tts_server.py

Set Vercel env:
  TTS_PIPELINE_MODE=moss
  MOSS_AB_VARIANT=sglang
  MODAL_MOSS_SGLANG_TTS_URL=https://<user>--echomancer-sglang-tts-fastapi-app.modal.run/generate_batch
  MODAL_TTS_URL=<same URL>  # voice preview + warmup

Optional Modal env:
  SGLANG_MAX_WORKERS (default 2)   — parallel GPU containers
  SGLANG_BATCH_CHARS (default 2000) — text per synthesis request

Rollback: MOSS_AB_VARIANT=delay|local|api.
"""

from __future__ import annotations

import base64
import os
import re
import shutil
import subprocess
import tempfile
import time
import traceback
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
    transcribe_with_whisper,
    upload_to_r2,
    verify_r2_permissions,
)

APP_NAME = "echomancer-sglang-tts"
MODEL_ID = "OpenMOSS-Team/MOSS-TTS-v1.5"
VARIANT_LABEL = "SGLang-Omni (MossTTSDelay-8B)"
OUTPUT_SAMPLE_RATE = 24000
GPU_CONFIG = "A100"
MAX_REF_SECONDS = 30
DEFAULT_LANGUAGE = "English"
SGLANG_PORT = 8000

SGLANG_MAX_WORKERS = int(os.environ.get("SGLANG_MAX_WORKERS", "2"))
SGLANG_BATCH_CHARS = int(os.environ.get("SGLANG_BATCH_CHARS", "2000"))
SGLANG_STARTUP_TIMEOUT = int(os.environ.get("SGLANG_STARTUP_TIMEOUT", "600"))
SGLANG_REQUEST_TIMEOUT = float(os.environ.get("SGLANG_REQUEST_TIMEOUT", "600"))

_MOSS_TTS_CONFIG = """config_cls: MossTTSPipelineConfig
model_path: OpenMOSS-Team/MOSS-TTS-v1.5
relay_backend: shm
"""

volume = modal.Volume.from_name("sglang-moss-tts-cache-v1", create_if_missing=True)

# Official SGLang-Omni image ships UCX, flash-attn, sglang, and CUDA prebuilt;
# only the sglang-omni package itself is installed on top.
gpu_image = (
    modal.Image.from_registry("lmsysorg/sglang-omni:dev", add_python=None)
    .run_commands(
        "git clone --depth 1 https://github.com/sgl-project/sglang-omni /opt/sglang-omni",
        "cd /opt/sglang-omni && pip install -v .",
        "pip install soundfile",
    )
    .run_commands(
        f"printf '{_MOSS_TTS_CONFIG}' > /opt/moss_tts.yaml",
    )
    .env({"HF_HOME": "/cache/huggingface"})
)

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
        "faster-whisper",
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


def apply_moss_pacing(text: str) -> str:
    """Add explicit pause markers for deliberately paced passages."""
    speed, _ = analyze_paragraph(text)
    if speed >= 0.85:
        return text
    paced = re.sub(r" — ", " — [pause 0.4s] ", text)
    paced = re.sub(r"; ", "; [pause 0.3s] ", paced)
    return paced


def _group_paragraphs_for_synthesis(
    paragraphs: list[str],
    max_chars: int = SGLANG_BATCH_CHARS,
) -> list[str]:
    batches: list[str] = []
    current: list[str] = []
    current_len = 0
    for text in paragraphs:
        text = text.strip()
        if not text:
            continue
        if current and current_len + len(text) > max_chars:
            batches.append(f" [pause {PARAGRAPH_SILENCE}s] ".join(current))
            current = []
            current_len = 0
        current.append(apply_moss_pacing(text))
        current_len += len(text)
    if current:
        batches.append(f" [pause {PARAGRAPH_SILENCE}s] ".join(current))
    return batches


@app.cls(
    image=gpu_image,
    gpu=GPU_CONFIG,
    timeout=3600,
    scaledown_window=300,
    max_containers=max(SGLANG_MAX_WORKERS, 1),
    volumes={"/cache": volume},
    secrets=[modal.Secret.from_name("echomancer-secrets")],
)
class SglangMossWorker:
    @modal.enter()
    def start_server(self):
        import httpx

        self._proc = subprocess.Popen(
            [
                "sgl-omni",
                "serve",
                "--model-path",
                MODEL_ID,
                "--config",
                "/opt/moss_tts.yaml",
                "--port",
                str(SGLANG_PORT),
            ],
        )
        deadline = time.time() + SGLANG_STARTUP_TIMEOUT
        base = f"http://localhost:{SGLANG_PORT}"
        with httpx.Client(timeout=5.0) as client:
            while time.time() < deadline:
                if self._proc.poll() is not None:
                    raise RuntimeError(
                        f"sgl-omni exited during startup (code {self._proc.returncode})"
                    )
                try:
                    r = client.get(f"{base}/health")
                    if r.status_code < 500:
                        volume.commit()
                        print(f"[SGLang] Server ready in container")
                        return
                except Exception:
                    pass
                time.sleep(3)
        raise RuntimeError(f"sgl-omni not ready after {SGLANG_STARTUP_TIMEOUT}s")

    @modal.exit()
    def stop_server(self):
        if getattr(self, "_proc", None) and self._proc.poll() is None:
            self._proc.terminate()

    @modal.method()
    def generate(self, text: str, reference_audio_base64: str, reference_text: str = "") -> bytes:
        """Synthesize one text chunk with zero-shot voice cloning. Returns WAV bytes."""
        import httpx

        payload: dict = {
            "input": text,
            "ref_audio": f"data:audio/wav;base64,{reference_audio_base64}",
        }
        if reference_text:
            payload["ref_text"] = reference_text
        with httpx.Client(timeout=SGLANG_REQUEST_TIMEOUT) as client:
            response = client.post(
                f"http://localhost:{SGLANG_PORT}/v1/audio/speech",
                json=payload,
            )
            response.raise_for_status()
            return response.content

    @modal.method()
    def ping(self) -> bool:
        return True


@app.function(
    image=cpu_image,
    timeout=3600,
    secrets=[modal.Secret.from_name("echomancer-secrets")],
)
def process_audiobook(request_dict: dict) -> dict:
    import fitz
    import httpx

    job_id = request_dict.get("job_id", "unknown")
    print(f"[SGLang Job {job_id}] Orchestrator STARTED")
    request = AudiobookRequest(**request_dict)
    temp_dir = tempfile.mkdtemp(prefix=f"sglang_{job_id}_")

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
        print(f"[SGLang Job {job_id}] Extracted {len(text)} characters")

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
                        print(f"[SGLang Job {job_id}] Voice cleaned via Audio Cleaner")
            except Exception as e:
                print(f"[SGLang Job {job_id}] Audio Cleaner skipped: {e}")

        reference_text = ""
        try:
            reference_text = transcribe_with_whisper(voice_final_path)
            print(f"[SGLang Job {job_id}] Reference transcript: {reference_text[:80]}")
        except Exception as e:
            print(f"[SGLang Job {job_id}] Whisper transcription skipped: {e}")

        with open(voice_final_path, "rb") as f:
            reference_audio_base64 = base64.b64encode(f.read()).decode("utf-8")

        text = normalize_punctuation(normalize_text(text))
        paragraphs = split_text_into_paragraphs(text, max_chars=MAX_PARAGRAPH_CHARS)
        if not paragraphs:
            raise ValueError("No paragraphs found")

        batch_texts = _group_paragraphs_for_synthesis(paragraphs)
        total_batches = len(batch_texts)
        print(
            f"[SGLang Job {job_id}] {len(paragraphs)} paragraphs, {total_batches} batches, "
            f"workers={SGLANG_MAX_WORKERS}"
        )

        send_webhook_async(
            request.webhook_url,
            {
                "job_id": job_id,
                "status": "processing",
                "progress": 10,
                "current_paragraph": 0,
                "total_paragraphs": len(paragraphs),
                "message": f"Starting {VARIANT_LABEL} synthesis ({total_batches} batches)",
            },
        )

        worker = SglangMossWorker()
        partial_files: list[str] = []
        done_count = 0
        for idx, wav_bytes in enumerate(
            worker.generate.map(
                batch_texts,
                kwargs={
                    "reference_audio_base64": reference_audio_base64,
                    "reference_text": reference_text,
                },
                order_outputs=True,
            )
        ):
            local_path = os.path.join(temp_dir, f"partial_{idx:04d}.wav")
            with open(local_path, "wb") as f:
                f.write(wav_bytes)
            partial_files.append(local_path)
            done_count += 1
            send_webhook_async(
                request.webhook_url,
                {
                    "job_id": job_id,
                    "status": "processing",
                    "progress": 10 + int(done_count / total_batches * 60),
                    "message": f"SGLang batch {done_count}/{total_batches} complete",
                },
            )

        send_webhook_async(
            request.webhook_url,
            {
                "job_id": job_id,
                "status": "processing",
                "progress": 75,
                "message": "SGLang batches complete, concatenating...",
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
            "variant": "sglang",
        }

    except Exception as e:
        error_msg = str(e)
        print(f"[SGLang Job {job_id}] ERROR: {error_msg}")
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

    web_app = FastAPI(title=f"Echomancer MOSS-TTS ({VARIANT_LABEL})")
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
                "variant": "sglang",
                "model": MODEL_ID,
                "gpu": GPU_CONFIG,
                "max_workers": SGLANG_MAX_WORKERS,
                "batch_chars": SGLANG_BATCH_CHARS,
                "timestamp": time.time(),
            }
        )

    @web_app.post("/warmup")
    async def warmup_endpoint(request: dict) -> JSONResponse:
        containers = min(int(request.get("containers", 1)), SGLANG_MAX_WORKERS)
        worker = SglangMossWorker()
        calls = [worker.ping.spawn() for _ in range(max(containers, 1))]
        return JSONResponse(
            {
                "status": "warming",
                "containers_ready": 0,
                "results": [c.object_id for c in calls],
                "variant": "sglang",
            }
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
                    "variant": "sglang",
                    "model": MODEL_ID,
                    "call_id": call.object_id,
                }
            )
        except Exception as e:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=str(e))

    @web_app.post("/generate_batch")
    async def generate_batch_endpoint(request: dict) -> JSONResponse:
        """Voice preview — zero-shot clone from user reference audio."""
        try:
            texts = request.get("texts") or [request.get("text", "Hello, this is a voice preview.")]
            reference_audio_base64 = request["reference_audio_base64"]
            worker = SglangMossWorker()
            results = []
            for text in texts:
                try:
                    wav_bytes = await worker.generate.remote.aio(
                        text, reference_audio_base64, ""
                    )
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
            return JSONResponse(
                {
                    "results": results,
                    "pipeline_mode": "moss",
                    "variant": "sglang",
                    "model": MODEL_ID,
                }
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    return web_app
