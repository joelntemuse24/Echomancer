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
        "zonos",
    )
)


@app.cls(
    gpu="L4",
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
        
        # Cache for speaker embeddings
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
            try:
                ref_bytes = base64.b64decode(ref_audio_b64)
            except Exception as e:
                return {"error": f"Invalid base64 audio: {str(e)}"}
            
            # Check file size - reject if too large (prevents OOM)
            if len(ref_bytes) > 20 * 1024 * 1024:  # 20MB max
                return {"error": "Voice sample too large. Please upload a smaller file (max ~10MB, 15-30 seconds)."}
            
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
        
        # Save raw audio
        raw_tmp = tempfile.NamedTemporaryFile(suffix=".audio", delete=False)
        raw_tmp.write(audio_bytes)
        raw_tmp.close()
        temp_files.append(raw_tmp.name)
        
        # First, detect audio format and convert to WAV
        wav_path = raw_tmp.name.replace(".audio", "_converted.wav")
        
        # Use simpler FFmpeg command - just convert, no clipping yet
        # This is more robust for various input formats
        cmd = [
            "ffmpeg", "-y",
            "-i", raw_tmp.name,
            "-ar", "24000", 
            "-ac", "1",
            "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",  # Normalize audio
            wav_path
        ]
        
        result = subprocess.run(cmd, capture_output=True, timeout=60)
        if result.returncode != 0:
            stderr = result.stderr.decode() if result.stderr else "Unknown error"
            print(f"FFmpeg conversion failed: {stderr[:500]}")
            raise RuntimeError(f"FFmpeg conversion failed: {stderr[:200]}")
        
        temp_files.append(wav_path)
        
        # Now load and check the converted audio
        try:
            y, sr = librosa.load(wav_path, sr=None)
            actual_duration = librosa.get_duration(y=y, sr=sr)
        except Exception as e:
            raise RuntimeError(f"Failed to load converted audio: {e}")
        
        print(f"Voice sample: {actual_duration:.1f}s at {sr}Hz")
        
        # Apply time clipping if needed
        clip_start = max(0, start_time)
        clip_end = min(end_time, actual_duration, 30)  # Max 30s
        clip_duration = clip_end - clip_start
        
        if clip_duration < 3:
            raise ValueError(f"Voice sample too short after clipping: {clip_duration:.1f}s (min 3s)")
        
        if clip_start > 0 or clip_end < actual_duration:
            # Need to clip
            print(f"Clipping to {clip_start:.1f}s - {clip_end:.1f}s ({clip_duration:.1f}s total)")
            
            start_sample = int(clip_start * sr)
            end_sample = int(clip_end * sr)
            y_clipped = y[start_sample:end_sample]
            
            # Save clipped version
            clipped_path = wav_path.replace(".wav", "_clipped.wav")
            sf.write(clipped_path, y_clipped, sr)
            temp_files.append(clipped_path)
            wav_path = clipped_path
        
        # If audio is still very long, extract best segment
        if clip_duration > 25:
            print(f"Audio too long ({clip_duration:.1f}s), extracting best 20s segment...")
            wav_path = self._extract_best_segment(y, sr, wav_path, temp_files)
        
        # Create speaker embedding using Zonos
        print("Creating speaker embedding...")
        try:
            speaker_embedding = self.model.create_speaker_embedding(wav_path)
        except Exception as e:
            raise RuntimeError(f"Failed to create speaker embedding: {e}")
        
        print(f"Speaker embedding shape: {speaker_embedding.shape}")
        
        return speaker_embedding

    def _extract_best_segment(
        self, 
        y: np.ndarray, 
        sr: int, 
        original_path: str,
        temp_files: list
    ) -> str:
        """Extract the best 20-second segment from longer audio."""
        import librosa
        import soundfile as sf
        
        segment_length = int(20 * sr)  # 20 seconds
        hop_length = int(5 * sr)       # 5 second hop
        
        best_score = -1
        best_start = 0
        
        for start in range(0, len(y) - segment_length, hop_length):
            segment = y[start:start + segment_length]
            
            # Calculate energy
            rms = np.sqrt(np.mean(segment ** 2))
            
            # Skip low energy
            if rms < 0.01:
                continue
            
            # Calculate pitch stability
            try:
                pitches, _ = librosa.piptrack(y=segment, sr=sr)
                pitch_vals = pitches[pitches > 0]
                if len(pitch_vals) > 10:
                    pitch_variance = np.var(pitch_vals)
                    score = rms / (1 + pitch_variance / 1000)
                    
                    if score > best_score:
                        best_score = score
                        best_start = start
            except:
                if rms > best_score:
                    best_score = rms
                    best_start = start
        
        if best_score < 0:
            print("Could not find good segment, using first 20s")
            best_start = 0
        
        # Extract best segment
        best_segment = y[best_start:best_start + segment_length]
        
        output_path = original_path.replace(".wav", "_best.wav")
        sf.write(output_path, best_segment, sr)
        temp_files.append(output_path)
        
        print(f"Extracted best 20s segment starting at {best_start/sr:.1f}s")
        return output_path

    def _encode_audio(self, audio_np: np.ndarray, sr: int, fmt: str, temp_files: list) -> bytes:
        """Encode audio to requested format."""
        import soundfile as sf
        
        # Normalize to prevent clipping
        max_val = np.abs(audio_np).max()
        if max_val > 0:
            audio_np = audio_np / max_val * 0.95
        
        audio_np = audio_np.astype(np.float32)

        if fmt == "mp3":
            # Write to temp WAV first
            wav_tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            sf.write(wav_tmp.name, audio_np, sr, subtype="FLOAT")
            wav_tmp.close()
            temp_files.append(wav_tmp.name)
            
            # Convert to MP3
            mp3_path = wav_tmp.name.replace(".wav", ".mp3")
            result = subprocess.run(
                ["ffmpeg", "-i", wav_tmp.name, "-b:a", "192k", "-y", mp3_path],
                capture_output=True, timeout=60
            )
            
            if result.returncode != 0:
                # Fallback to WAV if MP3 conversion fails
                print(f"MP3 conversion failed, returning WAV: {result.stderr.decode()[:200]}")
                with open(wav_tmp.name, "rb") as f:
                    return f.read()
            
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
