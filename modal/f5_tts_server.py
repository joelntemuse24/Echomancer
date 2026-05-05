"""
F5-TTS Server for Echomancer - Minimal Version
Uses F5-TTS from GitHub directly
"""

import os
import tempfile
import base64
import io
import time
from typing import List, Optional
from dataclasses import dataclass
from contextlib import contextmanager

import modal

GPU_CONFIG = "A10G"

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
        "git+https://github.com/SWivid/F5-TTS.git",
    )
)

volume = modal.Volume.from_name("f5-tts-cache-v2", create_if_missing=True)

app = modal.App("echomancer-f5-tts", image=image)


@dataclass
class BatchTTSRequest:
    texts: List[str]
    reference_audio_base64: str
    reference_text: Optional[str] = None
    speed: float = 1.0
    cfg_strength: float = 2.0
    nfe_step: int = 32


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
        
        # Limit to 15 seconds
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


from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

web_app = FastAPI(title="Echomancer F5-TTS")


@app.function(
    gpu=GPU_CONFIG,
    scaledown_window=300,
    timeout=600,
    volumes={"/cache": volume},
)
@modal.asgi_app()
def fastapi_app():
    server = F5TTSServer()
    
    @web_app.post("/generate_batch")
    async def generate_batch_endpoint(request: dict) -> JSONResponse:
        try:
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
            
    return web_app
