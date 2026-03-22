"""
Zonos TTS Server on Modal.
High-quality voice cloning with native long-form support.
- Supports 2000+ character chunks
- Better voice cloning than F5-TTS
- Faster inference
- Supports up to 30s voice samples
"""

import modal
import base64
import io
import os
import tempfile
import subprocess
from typing import Optional
import numpy as np

app = modal.App("zonos-tts")

# Use Zonos transformer model
image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg", "libsndfile1", "git")
    .pip_install(
        "torch>=2.1.0",
        "torchaudio",
        "soundfile",
        "numpy",
        "fastapi",
        "uvicorn",
        "transformers>=4.40.0",
        "einops",
        "inflect",
        "librosa",
        "zonos",  # Install from PyPI
    )
)


@app.cls(
    gpu="L4",  # Cheaper than A10G, Zonos runs well on it
    image=image,
    scaledown_window=300,
    timeout=600,
    container_idle_timeout=300,
)
@modal.concurrent(max_inputs=1)
class ZonosServer:
    @modal.enter()
    def load_model(self):
        """Load Zonos model into GPU memory."""
        import torch
        from zonos.model import Zonos
        
        print("Loading Zonos model...")
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        
        # Load the transformer variant (best quality)
        self.model = Zonos.from_pretrained("Zyphra/Zonos-v0.1-transformer", device=self.device)
        
        print(f"Zonos loaded on {self.device}!")
        
        # Cache for speaker embeddings (avoid recomputing for same voice)
        self._speaker_cache = {}

    @modal.fastapi_endpoint(method="POST")
    def generate(self, request: dict):
        """
        Generate TTS audio with Zonos voice cloning.
        
        Request format:
        {
            "text": "Text to speak...",
            "reference_audio_base64": "base64_encoded_audio...",
            "format": "mp3" | "wav",
            "start_time": 0,      // Optional: clip start in seconds
            "end_time": 30,       // Optional: clip end in seconds (max 30)
            "speaking_rate": 1.0  // Optional: speed multiplier (0.5-2.0)
        }
        
        Returns:
        {
            "audio_base64": "...",
            "format": "mp3",
            "size": 12345,
            "duration_seconds": 12.3
        }
        """
        import torch
        import soundfile as sf
        
        text = request.get("text", "").strip()
        ref_audio_b64 = request.get("reference_audio_base64", "")
        audio_format = request.get("format", "mp3")
        start_time = request.get("start_time", 0)
        end_time = request.get("end_time", 30)
        speaking_rate = request.get("speaking_rate", 1.0)
        
        if not text:
            return {"error": "text is required"}
        
        if not ref_audio_b64:
            return {"error": "reference_audio_base64 is required"}
        
        temp_files = []
        
        try:
            # Decode reference audio
            ref_bytes = base64.b64decode(ref_audio_b64)
            
            # Check cache first
            import hashlib
            ref_hash = hashlib.md5(ref_bytes[:10000]).hexdigest() + f"_{start_time}_{end_time}"
            
            if ref_hash in self._speaker_cache:
                print("Using cached speaker embedding")
                speaker_embedding = self._speaker_cache[ref_hash]
            else:
                # Process voice sample
                speaker_embedding = self._process_voice_sample(
                    ref_bytes, start_time, end_time, temp_files
                )
                # Cache for reuse
                self._speaker_cache[ref_hash] = speaker_embedding
            
            print(f"Generating audio for {len(text)} chars at {speaking_rate}x speed...")
            
            # Generate audio
            with torch.no_grad():
                audio_tensor = self.model.generate(
                    text=text,
                    speaker=speaker_embedding,
                    language="en",
                    # Zonos specific parameters
                    speaking_rate=speaking_rate,
                )
            
            # Convert to numpy
            audio_np = audio_tensor.squeeze().cpu().numpy()
            
            # Get sample rate from model
            sr = getattr(self.model, 'sample_rate', 24000)
            
            # Calculate duration
            duration = len(audio_np) / sr
            
            print(f"Generated {duration:.1f}s of audio")
            
            # Convert to requested format
            audio_bytes = self._encode_audio(audio_np, sr, audio_format, temp_files)
            
            return {
                "audio_base64": base64.b64encode(audio_bytes).decode("utf-8"),
                "format": audio_format,
                "size": len(audio_bytes),
                "duration_seconds": round(duration, 2),
            }
            
        except Exception as e:
            import traceback
            print(f"Error: {e}")
            return {"error": str(e), "traceback": traceback.format_exc()}
        
        finally:
            # Cleanup temp files
            for f in temp_files:
                try:
                    if os.path.exists(f):
                        os.unlink(f)
                except Exception as e:
                    print(f"Failed to cleanup {f}: {e}")

    def _process_voice_sample(
        self, 
        audio_bytes: bytes, 
        start_time: float,
        end_time: float,
        temp_files: list
    ):
        """Process voice sample and create speaker embedding."""
        import librosa
        import torch
        
        # Save raw audio
        raw_tmp = tempfile.NamedTemporaryFile(suffix=".audio", delete=False)
        raw_tmp.write(audio_bytes)
        raw_tmp.close()
        temp_files.append(raw_tmp.name)
        
        # Convert to WAV with clipping
        duration = min(end_time - start_time, 30)  # Max 30s
        wav_path = raw_tmp.name.replace(".audio", "_converted.wav")
        
        cmd = [
            "ffmpeg", "-i", raw_tmp.name,
            "-ss", str(start_time),
            "-t", str(duration),
            "-ar", "24000", "-ac", "1", "-y", wav_path
        ]
        
        result = subprocess.run(cmd, capture_output=True, timeout=30)
        if result.returncode != 0:
            raise RuntimeError(f"FFmpeg failed: {result.stderr.decode()}")
        
        temp_files.append(wav_path)
        
        # Check audio quality
        y, sr = librosa.load(wav_path, sr=None)
        actual_duration = librosa.get_duration(y=y, sr=sr)
        
        print(f"Voice sample: {actual_duration:.1f}s at {sr}Hz")
        
        if actual_duration < 3:
            raise ValueError(f"Voice sample too short: {actual_duration:.1f}s (min 3s)")
        
        if actual_duration > 30:
            print(f"Warning: Voice sample truncated to 30s from {actual_duration:.1f}s")
        
        # Create speaker embedding using Zonos
        print("Creating speaker embedding...")
        speaker_embedding = self.model.create_speaker_embedding(wav_path)
        
        print(f"Speaker embedding shape: {speaker_embedding.shape}")
        
        return speaker_embedding

    def _encode_audio(self, audio_np: np.ndarray, sr: int, fmt: str, temp_files: list) -> bytes:
        """Encode audio to requested format."""
        import soundfile as sf
        
        # Normalize to prevent clipping
        max_val = np.abs(audio_np).max()
        if max_val > 0:
            audio_np = audio_np / max_val * 0.95
        
        # Ensure float32
        audio_np = audio_np.astype(np.float32)
        
        if fmt == "mp3":
            # Write to temp WAV first
            wav_tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            sf.write(wav_tmp.name, audio_np, sr, subtype="FLOAT")
            wav_tmp.close()
            temp_files.append(wav_tmp.name)
            
            # Convert to MP3
            mp3_path = wav_tmp.name.replace(".wav", ".mp3")
            subprocess.run(
                ["ffmpeg", "-i", wav_tmp.name, "-b:a", "192k", "-y", mp3_path],
                capture_output=True, timeout=60, check=True
            )
            temp_files.append(mp3_path)
            
            with open(mp3_path, "rb") as f:
                return f.read()
        else:
            # Return WAV
            buf = io.BytesIO()
            sf.write(buf, audio_np, sr, format="WAV", subtype="FLOAT")
            buf.seek(0)
            return buf.read()


# Health check endpoint
@app.function(image=image)
@modal.web_endpoint(method="GET")
def health():
    return {"status": "ok", "model": "zonos-v0.1-transformer"}


# Test endpoint for quick validation
@app.cls(
    gpu="L4",
    image=image,
    scaledown_window=60,
)
class ZonosTest:
    @modal.enter()
    def load(self):
        from zonos.model import Zonos
        self.model = Zonos.from_pretrained("Zyphra/Zonos-v0.1-transformer", device="cuda")
    
    @modal.method()
    def test_generate(self, text: str = "Hello, this is a test."):
        """Quick test method."""
        import torch
        
        # Use default speaker (no cloning)
        audio = self.model.generate(
            text=text,
            speaker=None,  # Default voice
            language="en",
        )
        
        return {
            "text": text,
            "audio_samples": len(audio),
            "sample_rate": getattr(self.model, 'sample_rate', 24000),
        }
