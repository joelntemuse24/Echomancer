"""
Qwen3-TTS Server - Fast voice cloning with reusable prompts
- 3-second voice samples (vs 15s for F5-TTS)
- Reusable voice prompts (process once, generate many)
- Streaming support (97ms latency)
- Better quality (lower WER)
"""

import modal
import base64
import io
import os
import tempfile
import numpy as np
from typing import Optional, List, Dict, Any

app = modal.App("qwen3-tts")

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg", "libsndfile1", "sox", "libsox-fmt-all")
    .pip_install(
        "qwen-tts",
        "torch>=2.0.0",
        "torchaudio",
        "soundfile",
        "numpy",
        "fastapi",
        "uvicorn",
    )
    # Flash-attn disabled - using default PyTorch attention
)


@app.cls(
    gpu="L4",
    image=image,
    scaledown_window=300,
    timeout=600,
    # keep_warm disabled to save costs - cold start only affects first request
)
class Qwen3TTSServer:
    @modal.enter()
    def setup(self):
        """Load Qwen3-TTS model."""
        import torch
        from qwen_tts import Qwen3TTSModel
        
        print("Loading Qwen3-TTS 0.6B Base model...")
        # Use default attention (not flash_attn) since flash-attn compilation fails
        self.model = Qwen3TTSModel.from_pretrained(
            "Qwen/Qwen3-TTS-12Hz-0.6B-Base",  # Smaller model = faster cold start
            device_map="cuda:0",
            dtype=torch.bfloat16,
            # attn_implementation="flash_attention_2",  # Disabled - compilation issues
        )
        self.sample_rate = 24000
        
        # Cache for voice prompts (reusable across requests)
        self._voice_cache: Dict[str, Any] = {}
        print("Qwen3-TTS loaded!")
    
    def _decode_audio(self, audio_b64: str) -> tuple[np.ndarray, int]:
        """Decode base64 audio to numpy array."""
        import soundfile as sf
        
        audio_bytes = base64.b64decode(audio_b64)
        
        # Save to temp file and load
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(audio_bytes)
            temp_path = f.name
        
        try:
            audio_np, sr = sf.read(temp_path)
            return audio_np, sr
        finally:
            os.unlink(temp_path)
    
    def _encode_audio(self, audio_np: np.ndarray) -> str:
        """Encode numpy audio to base64."""
        import soundfile as sf
        
        # Save to temp file
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            sf.write(f.name, audio_np, self.sample_rate)
            temp_path = f.name
        
        try:
            with open(temp_path, "rb") as f:
                return base64.b64encode(f.read()).decode("utf-8")
        finally:
            os.unlink(temp_path)

    @modal.fastapi_endpoint(method="POST")
    def create_voice_prompt(self, request: dict):
        """
        Create a reusable voice prompt from reference audio.
        Call this once at the start, then use the prompt_key for all generation.
        
        Request: {
            "reference_audio_base64": "...",
            "reference_text": "transcript of the audio",
        }
        
        Response: {
            "prompt_key": "uuid",
            "message": "Voice prompt cached"
        }
        """
        import uuid
        
        ref_audio_b64 = request.get("reference_audio_base64", "")
        ref_text = request.get("reference_text", "")
        
        if not ref_audio_b64:
            return {"error": "reference_audio_base64 is required"}
        
        try:
            # Decode audio
            audio_np, sr = self._decode_audio(ref_audio_b64)
            
            # Create voice prompt
            prompt = self.model.create_voice_clone_prompt(
                ref_audio=(audio_np, sr),
                ref_text=ref_text if ref_text else None,
                x_vector_only_mode=not ref_text,  # If no text, use x-vector only
            )
            
            # Cache it
            prompt_key = str(uuid.uuid4())
            self._voice_cache[prompt_key] = prompt
            
            return {
                "prompt_key": prompt_key,
                "message": "Voice prompt created and cached",
                "has_reference_text": bool(ref_text),
            }
            
        except Exception as e:
            import traceback
            return {"error": str(e), "traceback": traceback.format_exc()}

    @modal.fastapi_endpoint(method="POST")
    def generate(self, request: dict):
        """
        Generate TTS audio using a cached voice prompt or reference audio.
        
        Request (with cached prompt): {
            "text": "text to speak",
            "prompt_key": "uuid-from-create-voice-prompt",
            "language": "English"  // optional, defaults to auto
        }
        
        Request (with reference audio - slower): {
            "text": "text to speak",
            "reference_audio_base64": "...",
            "reference_text": "transcript",
            "language": "English"
        }
        
        Response: {
            "audio_base64": "...",
            "sample_rate": 24000,
            "duration_seconds": N
        }
        """
        text = request.get("text", "").strip()
        prompt_key = request.get("prompt_key", "")
        ref_audio_b64 = request.get("reference_audio_base64", "")
        ref_text = request.get("reference_text", "")
        language = request.get("language", "auto")
        
        if not text:
            return {"error": "text is required"}
        
        if not prompt_key and not ref_audio_b64:
            return {"error": "Either prompt_key or reference_audio_base64 is required"}
        
        try:
            # Get voice prompt (cached or create from reference)
            if prompt_key:
                if prompt_key not in self._voice_cache:
                    return {"error": f"Prompt key '{prompt_key}' not found. Create it first with /create_voice_prompt"}
                voice_prompt = self._voice_cache[prompt_key]
                
                # Generate with cached prompt
                wavs, sr = self.model.generate_voice_clone(
                    text=text,
                    language=language,
                    voice_clone_prompt=voice_prompt,
                )
            else:
                # Decode reference audio
                audio_np, sr = self._decode_audio(ref_audio_b64)
                
                # Generate with reference audio (slower - processes voice each time)
                wavs, sr = self.model.generate_voice_clone(
                    text=text,
                    language=language,
                    ref_audio=(audio_np, sr),
                    ref_text=ref_text if ref_text else None,
                )
            
            # Encode result
            audio_b64 = self._encode_audio(wavs[0])
            duration = len(wavs[0]) / sr
            
            return {
                "audio_base64": audio_b64,
                "sample_rate": sr,
                "duration_seconds": round(duration, 2),
                "format": "wav",
            }
            
        except Exception as e:
            import traceback
            return {"error": str(e), "traceback": traceback.format_exc()}

    @modal.fastapi_endpoint(method="POST")
    def generate_batch(self, request: dict):
        """
        Batch generate TTS audio. Much faster than multiple single calls.
        
        Request: {
            "texts": ["text1", "text2", ...],
            "prompt_key": "uuid",
            "language": "English"  // or ["English", "Chinese", ...] per text
        }
        
        Response: {
            "results": [
                {"audio_base64": "...", "duration_seconds": N},
                ...
            ],
            "sample_rate": 24000
        }
        """
        texts = request.get("texts", [])
        prompt_key = request.get("prompt_key", "")
        ref_audio_b64 = request.get("reference_audio_base64", "")
        ref_text = request.get("reference_text", "")
        language = request.get("language", "auto")
        
        if not texts:
            return {"error": "texts array is required"}
        
        if not prompt_key and not ref_audio_b64:
            return {"error": "Either prompt_key or reference_audio_base64 is required"}
        
        try:
            # Get voice prompt
            if prompt_key:
                if prompt_key not in self._voice_cache:
                    return {"error": f"Prompt key '{prompt_key}' not found"}
                voice_prompt = self._voice_cache[prompt_key]
                
                # Batch generate with cached prompt
                wavs, sr = self.model.generate_voice_clone(
                    text=texts,
                    language=[language] * len(texts) if isinstance(language, str) else language,
                    voice_clone_prompt=voice_prompt,
                )
            else:
                # Decode reference audio
                audio_np, sr = self._decode_audio(ref_audio_b64)
                
                # Batch generate with reference audio
                wavs, sr = self.model.generate_voice_clone(
                    text=texts,
                    language=[language] * len(texts) if isinstance(language, str) else language,
                    ref_audio=(audio_np, sr),
                    ref_text=ref_text if ref_text else None,
                )
            
            # Encode all results
            results = []
            for wav in wavs:
                audio_b64 = self._encode_audio(wav)
                duration = len(wav) / sr
                results.append({
                    "audio_base64": audio_b64,
                    "duration_seconds": round(duration, 2),
                })
            
            return {
                "results": results,
                "sample_rate": sr,
                "batch_size": len(texts),
            }
            
        except Exception as e:
            import traceback
            return {"error": str(e), "traceback": traceback.format_exc()}


@app.function(image=image, timeout=120)
@modal.fastapi_endpoint(method="GET")
def health():
    return {
        "status": "ok",
        "model": "qwen3-tts-0.6b-base",
        "features": [
            "voice_clone",
            "reusable_prompts",
            "batch_generation",
            "streaming_ready"
        ],
    }
