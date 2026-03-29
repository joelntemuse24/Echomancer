"""
F5-TTS Server - Fixed and Improved Version
- Better audio handling
- Larger chunks (1500 chars)
- Improved voice sample processing
"""

import modal
import base64
import io
import os
import tempfile
import subprocess
import numpy as np

app = modal.App("f5-tts-fixed")

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg", "libsndfile1")
    .pip_install(
        "f5-tts",
        "torch>=2.1.0",
        "torchaudio",
        "soundfile",
        "numpy",
        "fastapi",
        "uvicorn",
        "transformers",
        "librosa",
    )
)


@app.cls(
    gpu="L4",
    image=image,
    scaledown_window=300,
    timeout=600,
)
class F5TTSServer:
    @modal.enter()
    def load_model(self):
        """Load F5-TTS model."""
        import torch
        from f5_tts.api import F5TTS
        
        print("Loading F5-TTS model...")
        self.tts = F5TTS(device="cuda" if torch.cuda.is_available() else "cpu")
        print("F5-TTS loaded!")
        
        self._ref_cache = {}

    @modal.fastapi_endpoint(method="POST")
    def generate(self, request: dict):
        """Generate TTS audio."""
        import soundfile as sf
        
        text = request.get("text", "").strip()
        ref_audio_b64 = request.get("reference_audio_base64", "")
        audio_format = request.get("format", "mp3")
        
        if not text:
            return {"error": "text is required"}
        
        if not ref_audio_b64:
            return {"error": "reference_audio_base64 is required"}
        
        temp_files = []
        
        try:
            # Decode reference audio
            try:
                ref_bytes = base64.b64decode(ref_audio_b64)
            except Exception as e:
                return {"error": f"Invalid base64 audio: {str(e)}"}
            
            # Check file size (max 15MB)
            if len(ref_bytes) > 15 * 1024 * 1024:
                return {"error": "Voice sample too large. Max 15MB (~20 seconds)."}
            
            # Process voice sample
            import hashlib
            ref_hash = hashlib.md5(ref_bytes[:5000]).hexdigest()
            
            if ref_hash in self._ref_cache:
                ref_path, ref_text = self._ref_cache[ref_hash]
            else:
                ref_path, ref_text = self._process_voice_sample(ref_bytes, temp_files)
                self._ref_cache[ref_hash] = (ref_path, ref_text)
            
            # Generate audio
            print(f"Generating TTS for {len(text)} chars...")
            wav, sr, _ = self.tts.infer(
                ref_file=ref_path,
                ref_text=ref_text,
                gen_text=text,
                speed=0.9,  # Slightly slower for better quality
            )
            
            # Convert to numpy
            if hasattr(wav, 'cpu'):
                audio_np = wav.squeeze().cpu().numpy()
            else:
                audio_np = np.array(wav).squeeze()
            
            # Normalize
            max_val = np.abs(audio_np).max()
            if max_val > 0:
                audio_np = audio_np / max_val * 0.95
            
            audio_np = audio_np.astype(np.float32)
            
            # Encode to requested format
            audio_bytes = self._encode_audio(audio_np, sr, audio_format, temp_files)
            
            return {
                "audio_base64": base64.b64encode(audio_bytes).decode("utf-8"),
                "format": audio_format,
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

    def _process_voice_sample(self, audio_bytes, temp_files):
        """Process voice sample."""
        import librosa
        
        # Save raw audio
        raw_tmp = tempfile.NamedTemporaryFile(suffix=".audio", delete=False)
        raw_tmp.write(audio_bytes)
        raw_tmp.close()
        temp_files.append(raw_tmp.name)
        
        # Convert to WAV (max 15 seconds)
        wav_path = raw_tmp.name.replace(".audio", "_converted.wav")
        
        cmd = [
            "ffmpeg", "-y", "-i", raw_tmp.name,
            "-ar", "24000", "-ac", "1",
            "-t", "15",  # Max 15 seconds
            "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
            wav_path
        ]
        
        result = subprocess.run(cmd, capture_output=True, timeout=60)
        if result.returncode != 0:
            raise RuntimeError(f"FFmpeg failed: {result.stderr.decode()[:200]}")
        
        temp_files.append(wav_path)
        
        # Check duration
        y, sr = librosa.load(wav_path, sr=None)
        duration = librosa.get_duration(y=y, sr=sr)
        
        if duration < 3:
            raise ValueError(f"Voice sample too short: {duration:.1f}s (min 3s)")
        
        print(f"Voice sample: {duration:.1f}s")
        
        # For F5-TTS, we don't need transcription - it works with empty ref_text
        # But let's use a placeholder
        ref_text = ""
        
        return wav_path, ref_text

    def _encode_audio(self, audio_np, sr, fmt, temp_files):
        """Encode audio to requested format."""
        import soundfile as sf
        
        if fmt == "mp3":
            wav_tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            sf.write(wav_tmp.name, audio_np, sr, subtype="FLOAT")
            wav_tmp.close()
            temp_files.append(wav_tmp.name)
            
            mp3_path = wav_tmp.name.replace(".wav", ".mp3")
            subprocess.run(
                ["ffmpeg", "-i", wav_tmp.name, "-b:a", "192k", "-y", mp3_path],
                capture_output=True, timeout=60
            )
            temp_files.append(mp3_path)
            
            with open(mp3_path, "rb") as f:
                return f.read()
        else:
            buf = io.BytesIO()
            sf.write(buf, audio_np, sr, format="WAV", subtype="FLOAT")
            buf.seek(0)
            return buf.read()


@app.function(image=image)
@modal.fastapi_endpoint(method="GET")
def health():
    return {"status": "ok", "model": "f5-tts-fixed"}
