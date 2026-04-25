"""
F5-TTS Minimal Server - Fast deployment using Modal's PyTorch base image
"""

import modal
from pydantic import BaseModel
from typing import Optional, List

# Use Modal's pre-built PyTorch image - much faster build
image = (
    modal.Image.from_registry(
        "pytorch/pytorch:2.1.0-cuda12.1-cudnn8-runtime",
        add_python="3.11"
    )
    .apt_install("git", "ffmpeg", "libsndfile1", "espeak-ng")
    .pip_install(
        "f5-tts",
        "soundfile",
        "pydub",
        "huggingface-hub",
        "transformers",
        "accelerate",
        "einops",
        "inflect",
    )
)

app = modal.App("f5-tts", image=image)

class TTSRequest(BaseModel):
    text: str
    reference_audio_base64: str
    reference_text: str = ""
    speed: float = 1.0

@app.cls(
    gpu="L4",
    scaledown_window=300,
    timeout=300,
)
class F5TTSServer:
    @modal.enter()
    def setup(self):
        from f5_tts.api import F5TTS
        
        print("Loading F5-TTS model...")
        self.model = F5TTS(
            model_type="F5-TTS",
            device="cuda",
        )
        self.sample_rate = 24000
        print("✓ F5-TTS ready")

    @modal.fastapi_endpoint(method="POST")
    def generate(self, request: TTSRequest):
        import base64
        import io
        import soundfile as sf
        import numpy as np
        
        try:
            # Decode audio
            audio_bytes = base64.b64decode(request.reference_audio_base64)
            with io.BytesIO(audio_bytes) as buf:
                ref_audio, sr = sf.read(buf)
            
            if len(ref_audio.shape) > 1:
                ref_audio = ref_audio.mean(axis=1)
            
            # Generate
            audio = self.model.infer(
                text=request.text,
                ref_audio=ref_audio,
                ref_text=request.reference_text,
                speed=request.speed,
            )
            
            # Process output
            if hasattr(audio, 'cpu'):
                audio = audio.cpu().numpy()
            if isinstance(audio, tuple):
                audio = audio[0]
            audio = np.array(audio).squeeze()
            
            # Normalize
            if np.max(np.abs(audio)) > 1:
                audio = audio / np.max(np.abs(audio))
            
            # Encode
            with io.BytesIO() as buf:
                sf.write(buf, audio, self.sample_rate, format="WAV")
                audio_b64 = base64.b64encode(buf.getvalue()).decode()
            
            return {
                "audio_base64": audio_b64,
                "sample_rate": self.sample_rate,
                "duration_seconds": len(audio) / self.sample_rate,
            }
            
        except Exception as e:
            import traceback
            return {"error": str(e), "traceback": traceback.format_exc()}

@app.function(image=image)
@modal.fastapi_endpoint(method="GET")
def health():
    return {"status": "ok", "model": "F5-TTS"}
