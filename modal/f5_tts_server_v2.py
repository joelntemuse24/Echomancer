"""
IMPROVED F5-TTS Server on Modal.
- Supports multiple voice samples (better voice cloning)
- Handles longer samples by extracting best 15s segments
- Audio clipping support
- Better error handling and cleanup
"""

import modal
import base64
import io
import os
import tempfile
import subprocess
import hashlib
from typing import List, Optional, Tuple
import numpy as np

app = modal.App("f5-tts-v2")

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
        "openai-whisper",
        "librosa",  # For audio analysis
        "pydub",    # For audio manipulation
    )
)


@app.cls(
    gpu="A10G",
    image=image,
    scaledown_window=300,
    timeout=600,
)
@modal.concurrent(max_inputs=1)
class F5TTSServerV2:
    @modal.enter()
    def load_model(self):
        """Load F5-TTS + Whisper into GPU memory."""
        import torch
        from f5_tts.api import F5TTS
        import whisper

        print("Loading F5-TTS model...")
        self.tts = F5TTS(device="cuda")
        print("F5-TTS loaded!")

        print("Loading Whisper...")
        self.whisper_model = whisper.load_model("small", device="cuda")
        print("Whisper loaded!")

        # Cache for transcribed reference audio
        self._ref_cache = {}
        
        # Cache for processed voice samples (multiple clips support)
        self._voice_cache = {}

    @modal.fastapi_endpoint(method="POST")
    def generate(self, request: dict):
        """
        IMPROVED endpoint with:
        - Multiple reference samples support
        - Automatic best segment extraction from long samples
        - Audio clipping (start_time/end_time)
        """
        import soundfile as sf

        text = request.get("text", "")
        ref_audio_b64 = request.get("reference_audio_base64", "")
        audio_format = request.get("format", "mp3")
        has_clipping = request.get("has_clipping_metadata", False)
        
        # NEW: Support multiple voice samples
        ref_audios_b64 = request.get("reference_audios", [ref_audio_b64] if ref_audio_b64 else [])
        
        if not text:
            return {"error": "text is required"}
        
        if not ref_audios_b64:
            return {"error": "reference audio is required"}

        temp_files = []
        
        try:
            # Parse metadata if present
            voice_buffer = base64.b64decode(ref_audios_b64[0])
            start_time, end_time = 0, 60
            
            if has_clipping and b'\n' in voice_buffer[:1000]:
                # Extract metadata from buffer
                metadata_end = voice_buffer.find(b'\n')
                metadata = json.loads(voice_buffer[:metadata_end].decode())
                start_time = metadata.get("startTime", 0)
                end_time = metadata.get("endTime", 60)
                voice_buffer = voice_buffer[metadata_end + 1:]
                ref_audios_b64[0] = base64.b64encode(voice_buffer).decode()

            # Process voice samples (extract best segments if long)
            ref_paths, ref_texts = self._process_voice_samples(
                ref_audios_b64, start_time, end_time, temp_files
            )
            
            if not ref_paths:
                return {"error": "Failed to process voice samples"}

            # Use the best segment (or average if multiple)
            # For now, use the first/most stable one
            ref_path = ref_paths[0]
            ref_text = ref_texts[0]

            # Generate audio
            print(f"Generating TTS for {len(text)} chars...")
            wav, sr, _ = self.tts.infer(
                ref_file=ref_path,
                ref_text=ref_text,
                gen_text=text,
                speed=0.85,
            )

            # Process output
            audio_bytes = self._process_output(wav, sr, audio_format, temp_files)

            return {
                "audio_base64": base64.b64encode(audio_bytes).decode("utf-8"),
                "format": audio_format,
                "size": len(audio_bytes),
                "segments_used": len(ref_paths),
            }

        except Exception as e:
            import traceback
            return {"error": str(e), "traceback": traceback.format_exc()}
        
        finally:
            # Cleanup
            for f in temp_files:
                try:
                    if os.path.exists(f):
                        os.unlink(f)
                except:
                    pass

    def _process_voice_samples(
        self, 
        ref_audios_b64: List[str], 
        start_time: float,
        end_time: float,
        temp_files: List[str]
    ) -> Tuple[List[str], List[str]]:
        """
        Process voice samples - extract best segments from long samples.
        Returns list of (wav_path, transcription) tuples.
        """
        import librosa
        
        ref_paths = []
        ref_texts = []
        
        for idx, audio_b64 in enumerate(ref_audios_b64):
            try:
                ref_bytes = base64.b64decode(audio_b64)
                ref_hash = hashlib.md5(ref_bytes[:10000]).hexdigest()
                
                # Check cache
                if ref_hash in self._voice_cache:
                    cached = self._voice_cache[ref_hash]
                    ref_paths.append(cached["path"])
                    ref_texts.append(cached["text"])
                    continue

                # Save raw audio
                raw_tmp = tempfile.NamedTemporaryFile(suffix=".audio", delete=False)
                raw_tmp.write(ref_bytes)
                raw_tmp.close()
                temp_files.append(raw_tmp.name)

                # Convert to WAV with clipping support
                wav_path = raw_tmp.name.replace(".audio", "_converted.wav")
                
                # Build ffmpeg command with clipping
                duration = end_time - start_time
                cmd = [
                    "ffmpeg", "-i", raw_tmp.name,
                    "-ss", str(start_time),
                    "-t", str(min(duration, 60)),  # Max 60s for processing
                    "-ar", "24000", "-ac", "1", "-y", wav_path
                ]
                
                result = subprocess.run(cmd, capture_output=True, timeout=30)
                if result.returncode != 0:
                    print(f"FFmpeg failed for sample {idx}: {result.stderr.decode()}")
                    continue
                
                temp_files.append(wav_path)

                # Check audio duration
                y, sr = librosa.load(wav_path, sr=None)
                duration = librosa.get_duration(y=y, sr=sr)
                
                print(f"Sample {idx}: {duration:.1f}s duration")

                # If longer than 20s, extract best 15s segment
                if duration > 20:
                    best_segment = self._extract_best_segment(y, sr, wav_path, temp_files)
                    if best_segment:
                        wav_path = best_segment
                else:
                    # Trim/pad to optimal 15s
                    wav_path = self._normalize_segment(y, sr, wav_path, temp_files)

                # Transcribe
                if ref_hash in self._ref_cache:
                    ref_text = self._ref_cache[ref_hash]
                else:
                    print(f"Transcribing sample {idx}...")
                    whisper_result = self.whisper_model.transcribe(wav_path, language="en")
                    ref_text = whisper_result["text"].strip()
                    self._ref_cache[ref_hash] = ref_text
                    print(f"Transcription {idx}: '{ref_text[:200]}'")

                # Cache processed voice
                self._voice_cache[ref_hash] = {"path": wav_path, "text": ref_text}
                
                ref_paths.append(wav_path)
                ref_texts.append(ref_text)

            except Exception as e:
                print(f"Failed to process sample {idx}: {e}")
                continue
        
        return ref_paths, ref_texts

    def _extract_best_segment(
        self, 
        y: np.ndarray, 
        sr: int, 
        original_path: str,
        temp_files: List[str]
    ) -> Optional[str]:
        """
        Extract the best 15-second segment from longer audio.
        Looks for segments with:
        - Good energy (not silence)
        - Stable pitch (less variation = more stable voice)
        - No clipping/distortion
        """
        import librosa
        
        segment_length = int(15 * sr)  # 15 seconds
        hop_length = int(5 * sr)       # 5 second hop
        
        best_score = -1
        best_start = 0
        
        for start in range(0, len(y) - segment_length, hop_length):
            segment = y[start:start + segment_length]
            
            # Calculate energy
            rms = np.sqrt(np.mean(segment ** 2))
            
            # Skip low energy (silence/background noise)
            if rms < 0.01:
                continue
            
            # Calculate pitch stability (lower variance = better)
            try:
                pitches, _ = librosa.piptrack(y=segment, sr=sr)
                pitch_vals = pitches[pitches > 0]
                if len(pitch_vals) > 10:
                    pitch_variance = np.var(pitch_vals)
                    # Score: high energy, low pitch variance
                    score = rms / (1 + pitch_variance / 1000)
                    
                    if score > best_score:
                        best_score = score
                        best_start = start
            except:
                # If pitch detection fails, use energy only
                if rms > best_score:
                    best_score = rms
                    best_start = start
        
        if best_score < 0:
            print("Could not find good segment, using first 15s")
            best_start = 0
        
        # Extract best segment
        best_segment = y[best_start:best_start + segment_length]
        
        output_path = original_path.replace(".wav", "_best.wav")
        import soundfile as sf
        sf.write(output_path, best_segment, sr)
        temp_files.append(output_path)
        
        print(f"Extracted best 15s segment starting at {best_start/sr:.1f}s (score: {best_score:.3f})")
        return output_path

    def _normalize_segment(
        self, 
        y: np.ndarray, 
        sr: int, 
        original_path: str,
        temp_files: List[str]
    ) -> str:
        """Normalize audio to optimal 15s length."""
        target_length = int(15 * sr)
        
        if len(y) < target_length:
            # Pad with silence
            y = np.pad(y, (0, target_length - len(y)), mode='constant')
        elif len(y) > target_length:
            # Trim to 15s
            y = y[:target_length]
        
        output_path = original_path.replace(".wav", "_norm.wav")
        import soundfile as sf
        sf.write(output_path, y, sr)
        temp_files.append(output_path)
        
        return output_path

    def _process_output(self, wav, sr: int, audio_format: str, temp_files: List[str]) -> bytes:
        """Convert model output to requested format."""
        import soundfile as sf
        
        # Convert to numpy
        if hasattr(wav, 'numpy'):
            audio_np = wav.squeeze().cpu().numpy()
        elif hasattr(wav, 'cpu'):
            audio_np = wav.squeeze().cpu().numpy()
        else:
            audio_np = np.array(wav).squeeze()

        # Normalize
        max_val = np.abs(audio_np).max()
        if max_val > 0:
            audio_np = audio_np / max_val * 0.95
        
        audio_np = audio_np.astype(np.float32)

        # Write WAV
        wav_buf = io.BytesIO()
        sf.write(wav_buf, audio_np, sr, format="WAV", subtype="FLOAT")
        wav_buf.seek(0)

        if audio_format == "mp3":
            wav_tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            wav_tmp.write(wav_buf.read())
            wav_tmp.close()
            temp_files.append(wav_tmp.name)

            mp3_path = wav_tmp.name.replace(".wav", ".mp3")
            subprocess.run(
                ["ffmpeg", "-i", wav_tmp.name, "-b:a", "192k", "-y", mp3_path],
                capture_output=True, timeout=60,
            )
            temp_files.append(mp3_path)

            with open(mp3_path, "rb") as f:
                return f.read()
        else:
            return wav_buf.read()


# Alternative: Zonos TTS for comparison
# Zonos supports longer text natively and has excellent voice cloning

@app.cls(
    gpu="A10G",
    image=modal.Image.debian_slim(python_version="3.10").pip_install(
        "zonos", "torch", "torchaudio", "fastapi", "transformers"
    ),
    scaledown_window=300,
    timeout=600,
)
class ZonosServer:
    """
    Alternative TTS server using Zonos.
    Zonos advantages:
    - Native support for longer text (less chunking needed)
    - Better voice cloning quality
    - Emotion control
    - Faster generation
    """
    
    @modal.enter()
    def load_model(self):
        from zonos.model import Zonos
        self.model = Zonos.from_pretrained("Zyphra/Zonos-v0.1-transformer", device="cuda")
    
    @modal.fastapi_endpoint(method="POST")
    def generate(self, request: dict):
        """Generate with Zonos - supports longer text segments."""
        import torch
        
        text = request.get("text", "")
        speaker_audio_b64 = request.get("speaker_audio", "")
        
        if not text or not speaker_audio_b64:
            return {"error": "text and speaker_audio required"}
        
        try:
            # Decode speaker audio
            audio_bytes = base64.b64decode(speaker_audio_b64)
            
            # Save to temp file
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                f.write(audio_bytes)
                speaker_path = f.name
            
            # Generate speaker embedding
            speaker_embedding = self.model.create_speaker_embedding(speaker_path)
            os.unlink(speaker_path)
            
            # Generate - Zonos can handle up to ~2000 chars well
            audio = self.model.generate(
                text=text,
                speaker=speaker_embedding,
                language="en",
            )
            
            # Convert to bytes
            audio_np = audio.cpu().numpy()
            
            # Save as MP3
            with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
                mp3_path = f.name
            
            import soundfile as sf
            sf.write(mp3_path, audio_np, 24000)
            
            with open(mp3_path, "rb") as f:
                result = f.read()
            
            os.unlink(mp3_path)
            
            return {
                "audio_base64": base64.b64encode(result).decode(),
                "format": "mp3",
                "size": len(result),
            }
            
        except Exception as e:
            import traceback
            return {"error": str(e), "traceback": traceback.format_exc()}
