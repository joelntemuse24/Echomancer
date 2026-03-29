"""
Zonos TTS Server - FIXED INSTALLATION
"""

import modal
import base64
import io
import os
import tempfile
import subprocess
import numpy as np

app = modal.App("zonos-tts-v2")

# Clone and install Zonos properly
image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg", "libsndfile1", "git", "build-essential", "espeak", "espeak-data")
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
        "sentencepiece",
        "huggingface-hub",
        "phonemizer",
        "kanjize",
        "sudachipy",
        "sudachidict-full",
        "gradio",  # Zonos needs this
    )
    # Clone and install Zonos properly
    .run_commands(
        "cd /root && git clone https://github.com/Zyphra/Zonos.git",
        "cd /root/Zonos && touch zonos/__init__.py",  # FIX: Make zonos a proper Python package
        "cd /root/Zonos && pip install -e .",
    )
)


@app.cls(
    gpu="L4",
    image=image,
    scaledown_window=300,
    timeout=600,
)
class ZonosServer:
    @modal.enter()
    def load_model(self):
        """Load Zonos model."""
        import sys
        sys.path.insert(0, '/root/Zonos')
        
        import torch
        from zonos.model import Zonos
        
        print("Loading Zonos...")
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = Zonos.from_pretrained("Zyphra/Zonos-v0.1-transformer", device=self.device)
        print(f"Zonos loaded on {self.device}!")
        self._speaker_cache = {}

    @modal.fastapi_endpoint(method="POST")
    def generate(self, request: dict):
        """Generate TTS."""
        import sys
        sys.path.insert(0, '/root/Zonos')
        
        import torch
        
        text = request.get("text", "").strip()
        ref_audio_b64 = request.get("reference_audio_base64", "")
        
        if not text or not ref_audio_b64:
            return {"error": "text and reference_audio_base64 required"}
        
        temp_files = []
        
        try:
            ref_bytes = base64.b64decode(ref_audio_b64)
            
            if len(ref_bytes) > 15 * 1024 * 1024:
                return {"error": "Voice sample too large. Max 15MB."}
            
            # Process voice
            import hashlib
            ref_hash = hashlib.md5(ref_bytes[:5000]).hexdigest()
            
            if ref_hash in self._speaker_cache:
                speaker_embedding = self._speaker_cache[ref_hash]
            else:
                speaker_embedding = self._process_voice(ref_bytes, temp_files)
                self._speaker_cache[ref_hash] = speaker_embedding
            
            # Generate
            with torch.no_grad():
                audio = self.model.generate(
                    text=text,
                    speaker=speaker_embedding,
                    language="en",
                )
            
            audio_np = audio.squeeze().cpu().numpy()
            sr = 24000
            
            # Encode MP3
            audio_bytes = self._to_mp3(audio_np, sr, temp_files)
            
            return {
                "audio_base64": base64.b64encode(audio_bytes).decode(),
                "format": "mp3",
                "size": len(audio_bytes),
            }
            
        except Exception as e:
            import traceback
            return {"error": str(e), "traceback": traceback.format_exc()}
        finally:
            for f in temp_files:
                try:
                    if os.path.exists(f):
                        os.unlink(f)
                except:
                    pass

    def _process_voice(self, audio_bytes, temp_files):
        """Process voice sample."""
        import soundfile as sf
        import librosa
        
        # Save and convert
        raw = tempfile.NamedTemporaryFile(suffix=".audio", delete=False)
        raw.write(audio_bytes)
        raw.close()
        temp_files.append(raw.name)
        
        wav = raw.name.replace(".audio", ".wav")
        subprocess.run([
            "ffmpeg", "-y", "-i", raw.name,
            "-ar", "24000", "-ac", "1", "-t", "20",
            wav
        ], capture_output=True, timeout=60)
        temp_files.append(wav)
        
        # Check duration
        y, sr = librosa.load(wav, sr=None)
        if len(y) / sr < 3:
            raise ValueError("Voice sample too short (min 3s)")
        
        return self.model.create_speaker_embedding(wav)

    def _to_mp3(self, audio_np, sr, temp_files):
        """Convert to MP3."""
        import soundfile as sf
        
        # Normalize
        max_val = np.abs(audio_np).max()
        if max_val > 0:
            audio_np = audio_np / max_val * 0.95
        
        wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        sf.write(wav.name, audio_np.astype(np.float32), sr)
        wav.close()
        temp_files.append(wav.name)
        
        mp3 = wav.name.replace(".wav", ".mp3")
        subprocess.run([
            "ffmpeg", "-i", wav.name, "-b:a", "192k", "-y", mp3
        ], capture_output=True, timeout=60)
        temp_files.append(mp3)
        
        with open(mp3, "rb") as f:
            return f.read()


@app.function(image=image)
@modal.fastapi_endpoint(method="GET")
def health():
    return {"status": "ok"}
