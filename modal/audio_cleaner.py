"""
Audio Cleaner Server for Echomancer
Isolates vocals using Demucs
"""

import os
import tempfile
import base64
import io
from typing import Optional
from dataclasses import dataclass
from contextlib import contextmanager

import modal

GPU_CONFIG = "T4"

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg", "libsndfile1")
    .pip_install(
        "demucs",
        "torch",
        "torchaudio",
        "soundfile",
        "librosa",
        "numpy<2",
    )
)

volume = modal.Volume.from_name("audio-cleaner-cache-v1", create_if_missing=True)

app = modal.App("echomancer-audio-cleaner", image=image)


@dataclass
class CleanAudioRequest:
    audio_base64: str
    target_sample_rate: int = 24000
    normalize_loudness: bool = True
    target_lufs: float = -16.0


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
    scaledown_window=120,
    timeout=300,
    volumes={"/cache": volume},
)
class AudioCleaner:
    separator: object = None
    model_loaded: bool = False
    
    @modal.enter()
    def setup(self):
        import torch
        from demucs.pretrained import get_model
        
        self.separator = get_model("htdemucs_ft")
        self.separator.to("cuda")
        self.model_loaded = True
        
    def _decode_audio(self, audio_base64: str) -> tuple:
        import soundfile as sf
        import numpy as np
        
        audio_bytes = base64.b64decode(audio_base64)
        audio_io = io.BytesIO(audio_bytes)
        audio, sr = sf.read(audio_io)
        
        if len(audio.shape) > 1:
            audio = audio.mean(axis=1)
            
        return audio, sr
        
    def _isolate_vocals(self, audio, sr: int):
        import torch
        from demucs.apply import apply_model
        
        wav = torch.tensor(audio, dtype=torch.float32, device="cuda")
        wav = wav.unsqueeze(0).unsqueeze(0)
        
        with torch.no_grad():
            sources = apply_model(self.separator, wav, device="cuda")
            
        vocals = sources[0, 3, 0].cpu().numpy()
        return vocals
        
    def _trim_silence(self, audio, sr: int, threshold_db: float = -40):
        import numpy as np
        
        threshold = 10 ** (threshold_db / 20)
        above_threshold = np.abs(audio) > threshold
        
        if not np.any(above_threshold):
            return audio
            
        first = np.argmax(above_threshold)
        last = len(audio) - np.argmax(above_threshold[::-1])
        
        padding = int(0.1 * sr)
        first = max(0, first - padding)
        last = min(len(audio), last + padding)
        
        return audio[first:last]
        
    def _resample(self, audio, orig_sr: int, target_sr: int):
        import librosa
        
        if orig_sr == target_sr:
            return audio
            
        return librosa.resample(audio, orig_sr=orig_sr, target_sr=target_sr)
        
    @modal.method()
    def clean(self, request: CleanAudioRequest) -> dict:
        import soundfile as sf
        import numpy as np
        import time
        
        start_time = time.time()
        
        try:
            audio, sr = self._decode_audio(request.audio_base64)
            original_duration = len(audio) / sr
            
            vocals = self._isolate_vocals(audio, sr)
            vocals = self._trim_silence(vocals, sr)
            vocals = self._resample(vocals, sr, request.target_sample_rate)
            
            processed_duration = len(vocals) / request.target_sample_rate
            
            output_buffer = io.BytesIO()
            sf.write(output_buffer, vocals, request.target_sample_rate, format="WAV")
            output_buffer.seek(0)
            audio_base64 = base64.b64encode(output_buffer.read()).decode("utf-8")
            
            return {
                "audio_base64": audio_base64,
                "original_duration": original_duration,
                "processed_duration": processed_duration,
                "error": None,
            }
            
        except Exception as e:
            return {
                "audio_base64": None,
                "error": str(e),
                "original_duration": 0,
                "processed_duration": 0,
            }
            
    @modal.method()
    def health_check(self) -> dict:
        return {
            "status": "healthy",
            "model_loaded": self.model_loaded,
        }


from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

web_app = FastAPI(title="Echomancer Audio Cleaner")


@app.function(
    gpu=GPU_CONFIG,
    scaledown_window=120,
    timeout=300,
    volumes={"/cache": volume},
)
@modal.asgi_app()
def fastapi_app():
    cleaner = AudioCleaner()
    
    @web_app.post("/clean")
    async def clean_endpoint(request: dict) -> JSONResponse:
        try:
            clean_request = CleanAudioRequest(
                audio_base64=request["audio_base64"],
                target_sample_rate=request.get("target_sample_rate", 24000),
                normalize_loudness=request.get("normalize_loudness", True),
                target_lufs=request.get("target_lufs", -16.0),
            )
            
            result = cleaner.clean.remote(clean_request)
            
            if result.get("error"):
                raise HTTPException(status_code=500, detail=result["error"])
                
            return JSONResponse(content=result)
            
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
            
    @web_app.get("/health")
    async def health_endpoint() -> JSONResponse:
        return JSONResponse(content=cleaner.health_check.remote())
        
    return web_app
