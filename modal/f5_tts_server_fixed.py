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
        "torch==2.4.0",
        "torchaudio==2.4.0",
        "soundfile",
        "numpy",
        "fastapi",
        "uvicorn",
        "transformers",
        "librosa",
    )
    .run_commands("pip uninstall -y torchcodec || true")
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
        import threading
        
        # --- MONKEYPATCH F5-TTS BUG ---
        # F5-TTS internally uses ThreadPoolExecutor to generate audio chunks concurrently.
        # However, its transformer model caches text embeddings (self.text_cond) as instance variables,
        # making it fundamentally thread-unsafe. We replace ThreadPoolExecutor with a synchronous dummy
        # executor to prevent the "Sizes of tensors must match" matrix concatenation crash.
        import f5_tts.infer.utils_infer as utils_infer
        class DummyExecutor:
            def __enter__(self): return self
            def __exit__(self, exc_type, exc_val, exc_tb): pass
            def submit(self, fn, *args, **kwargs):
                class Future:
                    def result(self): return fn(*args, **kwargs)
                return Future()
        utils_infer.ThreadPoolExecutor = DummyExecutor
        # -------------------------------

        print("Loading F5-TTS model...")
        self.tts = F5TTS(device="cuda" if torch.cuda.is_available() else "cpu")
        print("F5-TTS loaded!")

        self._ref_cache = {}
        self._lock = threading.Lock()
        
    def _parse_sml_tags(self, text: str):
        """Parse SML tags: [emotion:xxx speed:X energy:Y], [break], [pause:N]"""
        import re
        
        # Pattern to match emotion tags with full parameters: [emotion:love speed:0.9 energy:low]
        # Also matches simple tags: [break], [pause:1.5]
        emotion_pattern = r'\[emotion:([a-z_]+)\s+speed:([0-9.]+)\s+energy:([a-z]+)\]'
        pause_pattern = r'\[pause:([0-9.]+)\]'
        break_pattern = r'\[break\]'
        
        # Track segments with their emotions and pauses
        segments = []
        pauses = []
        emotions = []
        
        last_end = 0
        current_emotion = "neutral"
        pending_pause = 0
        
        # Find all tags (emotions, pauses, breaks)
        all_tags = []
        
        for match in re.finditer(emotion_pattern, text):
            all_tags.append((match.start(), match.end(), 'emotion', match.groups()))
        for match in re.finditer(pause_pattern, text):
            all_tags.append((match.start(), match.end(), 'pause', (float(match.group(1)),)))
        for match in re.finditer(break_pattern, text):
            all_tags.append((match.start(), match.end(), 'break', ()))
        
        # Sort by position
        all_tags.sort(key=lambda x: x[0])
        
        for start, end, tag_type, groups in all_tags:
            # Text before the tag
            segment_text = text[last_end:start].strip()
            
            if tag_type == 'emotion':
                emotion_name, speed_str, energy = groups
                # If we have accumulated text, save it with previous emotion and any pending pause
                if segment_text:
                    segments.append(segment_text)
                    emotions.append(current_emotion)
                    pauses.append(pending_pause)
                    pending_pause = 0
                # Update current emotion
                current_emotion = emotion_name
                
            elif tag_type == 'break':
                if segment_text:
                    segments.append(segment_text)
                    emotions.append(current_emotion)
                    pauses.append(0.4)
                    
            elif tag_type == 'pause':
                pause_duration = groups[0]
                if segment_text:
                    segments.append(segment_text)
                    emotions.append(current_emotion)
                    pauses.append(pause_duration)
                else:
                    # No text before pause, save for next segment
                    pending_pause = pause_duration
            
            last_end = end
        
        # Add remaining text
        remaining = text[last_end:].strip()
        if remaining:
            segments.append(remaining)
            emotions.append(current_emotion)
            pauses.append(pending_pause)
        
        return segments, pauses, emotions

    @modal.fastapi_endpoint(method="POST")
    def generate(self, request: dict):
        """Generate TTS audio."""
        import soundfile as sf
        
        text = request.get("text", "").strip()
        ref_audio_b64 = request.get("reference_audio_base64", "")
        audio_format = request.get("format", "mp3")
        # Get speed from request, default to 1.0. F5-TTS sounds best around 0.9 natively, 
        # so we scale the requested speed by 0.9 to maintain quality.
        requested_speed = float(request.get("speed", 1.0))
        actual_speed = requested_speed * 0.9
        
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
                # Need to write it to a temp file again for this request
                # because the previous request's temp file was deleted
                cached_wav_bytes, ref_text = self._ref_cache[ref_hash]
                
                wav_tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
                wav_tmp.write(cached_wav_bytes)
                wav_tmp.close()
                ref_path = wav_tmp.name
                temp_files.append(ref_path)
            else:
                ref_path, ref_text = self._process_voice_sample(ref_bytes, temp_files)
                
                # Cache the bytes, not the path
                with open(ref_path, "rb") as f:
                    self._ref_cache[ref_hash] = (f.read(), ref_text)
            
            # Parse SML tags for pacing and emotion control
            segments, pauses, emotions = self._parse_sml_tags(text)
            
            if not segments:
                return {"error": "No text to generate after parsing SML tags"}
            
            print(f"Generating TTS for {len(segments)} segments with emotions: {emotions}")
            
            # Emotion to speed mapping
            emotion_speeds = {
                'sarcasm': 1.0, 'dry_wit': 1.05, 'melancholy': 0.82,
                'resignation': 0.90, 'longing': 0.85, 'grief': 0.82,
                'sadness': 0.85, 'love': 0.90, 'anger': 1.15,
                'excitement': 1.15, 'fear': 0.88, 'joy': 1.10,
                'neutral': 1.0, 'amusement': 1.10, 'surprise': 1.13
            }
            
            # Generate audio for each segment
            audio_segments = []
            sample_rate = None
            
            for i, segment in enumerate(segments):
                if not segment.strip():
                    continue
                
                # Get emotion-specific speed
                emotion = emotions[i] if i < len(emotions) else 'neutral'
                emotion_speed = emotion_speeds.get(emotion, 1.0)
                segment_speed = requested_speed * 0.9 * emotion_speed
                
                print(f"  Segment {i+1}/{len(segments)}: [{emotion}] {len(segment)} chars, speed={segment_speed:.2f}")
                
                with self._lock:
                    wav, sr, _ = self.tts.infer(
                        ref_file=ref_path,
                        ref_text=ref_text,
                        gen_text=segment,
                        speed=segment_speed,
                    )
                
                # Convert to numpy
                if hasattr(wav, 'cpu'):
                    audio_np = wav.squeeze().cpu().numpy()
                else:
                    audio_np = np.array(wav).squeeze()
                
                audio_segments.append(audio_np)
                sample_rate = sr
                
                # Add pause silence if there's a pause after this segment
                if i < len(pauses):
                    pause_duration = pauses[i]
                    pause_samples = int(pause_duration * sr)
                    silence = np.zeros(pause_samples, dtype=np.float32)
                    audio_segments.append(silence)
                    print(f"    Added {pause_duration}s pause")
            
            # Concatenate all segments
            full_audio = np.concatenate(audio_segments)
            
            # Normalize
            max_val = np.abs(full_audio).max()
            if max_val > 0:
                full_audio = full_audio / max_val * 0.95
            
            full_audio = full_audio.astype(np.float32)
            
            # Encode to requested format
            audio_bytes = self._encode_audio(full_audio, sample_rate, audio_format, temp_files)
            
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
