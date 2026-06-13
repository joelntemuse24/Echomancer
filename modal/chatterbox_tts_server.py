"""
Chatterbox Turbo TTS on Modal — Last Bone Phase A.

Deploy:
  modal deploy modal/chatterbox_tts_server.py
"""

from __future__ import annotations

import base64
import io
import os
import shutil
import tempfile
import time
import traceback

import modal
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

app = modal.App("echomancer-chatterbox-tts")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libsndfile1")
    .pip_install(
        "chatterbox-tts==0.1.6",
        "fastapi",
        "uvicorn",
        "peft==0.18.0",
        "torch==2.6.0",
        "torchaudio==2.6.0",
        "soundfile",
        "numpy<2",
    )
    .add_local_file("patch_chatterbox_perth.py", "/root/patch_chatterbox_perth.py", copy=True)
    .run_commands("python /root/patch_chatterbox_perth.py")
)

volume = modal.Volume.from_name("chatterbox-tts-cache-v1", create_if_missing=True)


@app.cls(
    image=image,
    gpu="L4",
    scaledown_window=120,
    timeout=1800,
    volumes={"/cache": volume},
    max_containers=4,
    secrets=[
        modal.Secret.from_name("echomancer-secrets"),
        modal.Secret.from_name("echomancer-f5-tts"),
    ],
)
class ChatterboxWorker:
    model: object = None
    sample_rate: int = 24000

    @modal.enter()
    def setup(self):
        from chatterbox.tts_turbo import ChatterboxTurboTTS

        hf_token = (
            os.environ.get("HF_TOKEN")
            or os.environ.get("HUGGING_FACE_HUB_TOKEN")
            or os.environ.get("HUGGINGFACE_TOKEN")
        )
        if not hf_token:
            raise RuntimeError(
                "Chatterbox Turbo weights require a Hugging Face token. "
                "Add HF_TOKEN to Modal secret 'hf-token' or 'echomancer-f5-tts'."
            )

        os.makedirs("/cache/chatterbox", exist_ok=True)
        os.environ["HF_TOKEN"] = hf_token
        self.model = ChatterboxTurboTTS.from_pretrained(device="cuda")
        self.sample_rate = int(getattr(self.model, "sr", 24000))
        print("[Chatterbox] Turbo model loaded")

    @modal.method()
    def warmup(self, dummy: int = 0) -> dict:
        return {"status": "warm", "dummy": dummy}

    @modal.method()
    def generate_chunk(
        self,
        text: str,
        ref_audio_base64: str,
        exaggeration: float = 0.55,
    ) -> dict:
        import soundfile as sf
        import torch
        import torchaudio as ta

        temp_dir = tempfile.mkdtemp(prefix="chatterbox_")
        try:
            ref_bytes = base64.b64decode(ref_audio_base64)
            ref_path = os.path.join(temp_dir, "ref.wav")
            with open(ref_path, "wb") as f:
                f.write(ref_bytes)

            with torch.inference_mode():
                wav = self.model.generate(
                    text,
                    audio_prompt_path=ref_path,
                    exaggeration=exaggeration,
                )

            if hasattr(wav, "squeeze"):
                wav_np = wav.squeeze().detach().cpu().numpy()
            else:
                wav_np = wav

            buffer = io.BytesIO()
            ta.save(buffer, wav_np, self.sample_rate, format="wav")
            audio_b64 = base64.b64encode(buffer.getvalue()).decode("utf-8")
            duration = len(wav_np) / self.sample_rate
            return {
                "status": "success",
                "audio_base64": audio_b64,
                "duration_seconds": duration,
                "sample_rate": self.sample_rate,
            }
        except TypeError:
            # Older turbo API without exaggeration kwarg
            try:
                with torch.inference_mode():
                    wav = self.model.generate(text, audio_prompt_path=ref_path)
                if hasattr(wav, "squeeze"):
                    wav_np = wav.squeeze().detach().cpu().numpy()
                else:
                    wav_np = wav
                buffer = io.BytesIO()
                ta.save(buffer, wav_np, self.sample_rate, format="wav")
                audio_b64 = base64.b64encode(buffer.getvalue()).decode("utf-8")
                duration = len(wav_np) / self.sample_rate
                return {
                    "status": "success",
                    "audio_base64": audio_b64,
                    "duration_seconds": duration,
                    "sample_rate": self.sample_rate,
                }
            except Exception as e:
                traceback.print_exc()
                return {"status": "error", "error": str(e)}
        except Exception as e:
            traceback.print_exc()
            return {"status": "error", "error": str(e)}
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)


@app.function(image=image, scaledown_window=120, timeout=900)
@modal.asgi_app()
def fastapi_app():
    web = FastAPI(title="Echomancer Chatterbox TTS")

    @web.get("/health")
    async def health():
        return {"status": "ok", "pipeline": "chatterbox_turbo", "timestamp": time.time()}

    @web.post("/warmup")
    async def warmup():
        worker = ChatterboxWorker()
        out = await worker.warmup.remote.aio(0)
        return {"status": "warm", **out}

    @web.post("/generate_single")
    async def generate_single(request: dict) -> JSONResponse:
        try:
            text = request.get("text", "")
            ref_b64 = request["reference_audio_base64"]
            exaggeration = float(request.get("exaggeration", 0.55))
            worker = ChatterboxWorker()
            out = await worker.generate_chunk.remote.aio(text, ref_b64, exaggeration)
            if out.get("status") != "success":
                raise HTTPException(status_code=500, detail=out.get("error", "generation failed"))
            return JSONResponse(
                {
                    "audio_base64": out["audio_base64"],
                    "duration_seconds": out.get("duration_seconds", 0),
                    "pipeline_path": "chatterbox_turbo",
                }
            )
        except HTTPException:
            raise
        except Exception as e:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=str(e))

    @web.post("/generate_batch")
    async def generate_batch(request: dict) -> JSONResponse:
        try:
            texts = request.get("texts") or [request.get("text", "Hello from Chatterbox.")]
            ref_b64 = request["reference_audio_base64"]
            exaggeration = float(request.get("exaggeration", 0.55))
            worker = ChatterboxWorker()
            outputs = []
            async for out in worker.generate_chunk.map.aio(
                texts,
                kwargs={"ref_audio_base64": ref_b64, "exaggeration": exaggeration},
            ):
                outputs.append(out)
            results = []
            for out in outputs:
                if out.get("status") != "success":
                    results.append(
                        {
                            "audio_base64": None,
                            "error": out.get("error"),
                            "pipeline_path": "chatterbox_failed",
                        }
                    )
                    continue
                results.append(
                    {
                        "audio_base64": out["audio_base64"],
                        "duration_seconds": out.get("duration_seconds", 0),
                        "error": None,
                        "pipeline_path": "chatterbox_turbo",
                    }
                )
            return JSONResponse({"results": results, "pipeline_mode": "chatterbox_turbo"})
        except Exception as e:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=str(e))

    return web


@app.local_entrypoint()
def smoke_test():
    """One-shot: modal run chatterbox_tts_server.py"""
    worker = ChatterboxWorker()
    print("Warming worker (loads model on container enter)...")
    print(worker.warmup.remote(0))