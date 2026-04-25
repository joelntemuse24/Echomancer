"""
F5-TTS Server - High-quality voice cloning
Using the proven F5-TTS model (v1.0.0+)
"""

import modal
import base64
import io
import re
from pydantic import BaseModel
from typing import Optional, List

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg", "libsndfile1", "espeak-ng")
    .pip_install(
        "f5-tts>=0.1.0",
        "torch>=2.0.0",
        "torchaudio>=2.0.0",
        "soundfile",
        "pydub",
        "huggingface-hub",
        "transformers",
        "accelerate",
    )
)

app = modal.App("f5-tts-server", image=image)

class TTSRequest(BaseModel):
    text: str
    reference_audio_base64: str
    reference_text: Optional[str] = ""
    speed: float = 1.0
    seed: Optional[int] = None

class BatchTTSRequest(BaseModel):
    texts: List[str]
    reference_audio_base64: str
    reference_text: Optional[str] = ""
    speed: float = 1.0
    seed: Optional[int] = None

@app.cls(
    gpu="L4",
    scaledown_window=600,
    timeout=600,
    container_idle_timeout=120,
)
class F5TTSServer:
    @modal.enter()
    def setup(self):
        import torch
        import soundfile as sf
        from f5_tts.api import F5TTS
        
        print("Loading F5-TTS model...")
        
        # Load the F5-TTS model
        # Using the pre-trained English model
        self.model = F5TTS(
            model_type="F5-TTS",
            ckpt_file="",  # Use default checkpoint from HF
            device="cuda",
        )
        
        self.sample_rate = 24000
        print("✓ F5-TTS loaded successfully")

    def _preprocess_text(self, text: str) -> str:
        """Clean text for TTS."""
        text = re.sub(r'\s+', ' ', text)
        text = text.strip()
        return text
    
    def _decode_audio(self, audio_base64: str):
        """Decode base64 audio to numpy array."""
        import soundfile as sf
        
        audio_bytes = base64.b64decode(audio_base64)
        
        with io.BytesIO(audio_bytes) as buf:
            audio_np, sr = sf.read(buf)
            
        if len(audio_np.shape) > 1:
            audio_np = audio_np.mean(axis=1)
            
        return audio_np, sr

    @modal.fastapi_endpoint(method="POST")
    def generate(self, request: TTSRequest):
        """Generate TTS audio with voice cloning."""
        import torch
        import soundfile as sf
        import numpy as np
        
        try:
            # Decode reference audio
            ref_audio, ref_sr = self._decode_audio(request.reference_audio_base64)
            
            # Preprocess text
            text = self._preprocess_text(request.text)
            ref_text = self._preprocess_text(request.reference_text or "")
            
            # Generate with F5-TTS
            audio_output = self.model.infer(
                text=text,
                ref_audio=ref_audio,
                ref_text=ref_text,
                speed=request.speed,
                seed=request.seed,
            )
            
            # Handle output format
            if isinstance(audio_output, torch.Tensor):
                audio_output = audio_output.cpu().numpy()
            elif isinstance(audio_output, tuple):
                audio_output = audio_output[0]
                if isinstance(audio_output, torch.Tensor):
                    audio_output = audio_output.cpu().numpy()
            
            # Ensure correct shape
            if len(audio_output.shape) > 1:
                audio_output = audio_output.squeeze()
            
            # Normalize audio
            if np.max(np.abs(audio_output)) > 1.0:
                audio_output = audio_output / np.max(np.abs(audio_output))
            
            # Encode to base64
            with io.BytesIO() as buf:
                sf.write(buf, audio_output, self.sample_rate, format="WAV")
                buf.seek(0)
                audio_b64 = base64.b64encode(buf.read()).decode()
            
            return {
                "audio_base64": audio_b64,
                "sample_rate": self.sample_rate,
                "duration_seconds": float(len(audio_output) / self.sample_rate),
                "text": text[:100] + "..." if len(text) > 100 else text,
            }
            
        except Exception as e:
            import traceback
            print(f"[F5-TTS Error] {str(e)}")
            return {
                "error": str(e),
                "traceback": traceback.format_exc(),
            }

    @modal.fastapi_endpoint(method="POST")
    def generate_batch(self, request: BatchTTSRequest):
        """Generate multiple TTS audios with voice cloning."""
        results = []
        
        for i, text in enumerate(request.texts):
            single_request = TTSRequest(
                text=text,
                reference_audio_base64=request.reference_audio_base64,
                reference_text=request.reference_text,
                speed=request.speed,
                seed=request.seed,
            )
            result = self.generate(single_request)
            results.append(result)
        
        return {
            "results": results,
            "total": len(results),
        }

@app.function(image=image)
@modal.fastapi_endpoint(method="GET")
def health():
    return {
        "status": "ok",
        "model": "F5-TTS",
        "version": "1.0.0",
        "features": ["voice_clone", "speed_control", "batch_generation"],
        "sample_rate": 24000,
    }
