"""
F5-TTS Server v3 - Performance & Quality Optimized
- Whisper ref_text for better voice cloning
- Batch endpoint (multiple texts per request)
- Native 24kHz (no wasteful upsampling)
- Audio context for chunk continuity
- Full hash for ref cache
"""

import modal
import base64
import io
import os
import tempfile
import subprocess
import numpy as np
from collections import OrderedDict

app = modal.App("f5-tts-v2")

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
        "faster-whisper",
        "yt-dlp",
    )
    .run_commands("pip uninstall -y torchcodec || true")
    # Pre-download F5-TTS model and Whisper model during build
    .run_commands(
        "python -c \"from f5_tts.api import F5TTS; F5TTS(device='cpu'); print('F5-TTS cached')\"",
        "python -c \"from faster_whisper import WhisperModel; WhisperModel('base', device='cpu'); print('Whisper cached')\"",
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
    def setup(self):
        """Setup - models loaded lazily on first request."""
        import threading
        self._tts = None
        self._whisper = None
        self._ref_cache = OrderedDict()  # LRU cache with max 50 entries
        self._ref_cache_max = 50
        self._lock = threading.Lock()
        print("F5-TTS container ready (models will load on first request)")
    
    def _get_model(self):
        """Lazy load F5-TTS model."""
        if self._tts is None:
            import torch
            from f5_tts.api import F5TTS
            
            # --- MONKEYPATCH F5-TTS BUG ---
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
            self._tts = F5TTS(
                device="cuda" if torch.cuda.is_available() else "cpu",
            )
            print("F5-TTS loaded!")
        return self._tts
        
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
        """Generate TTS audio with inference-time jitter for naturalness."""
        import soundfile as sf
        import random
        
        text = request.get("text", "").strip()
        ref_audio_b64 = request.get("reference_audio_base64", "")
        audio_format = request.get("format", "mp3")
        # Get speed from request, default to 1.0
        requested_speed = float(request.get("speed", 1.0))
        
        # Inference-time jitter: Add micro-variations for naturalness
        # This prevents robotic consistency and adds "human-like" variation
        jitter_amount = float(request.get("jitter", 0.03))  # Default 3% variation
        speed_jitter = 1.0 + random.uniform(-jitter_amount, jitter_amount)
        
        actual_speed = requested_speed * speed_jitter
        
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
            ref_hash = hashlib.md5(ref_bytes).hexdigest()
            
            if ref_hash in self._ref_cache:
                # Need to write it to a temp file again for this request
                # because the previous request's temp file was deleted
                cached_wav_bytes, ref_text = self._ref_cache.pop(ref_hash)  # pop to re-insert at end (LRU)
                self._ref_cache[ref_hash] = (cached_wav_bytes, ref_text)  # re-insert as most-recent
                
                wav_tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
                wav_tmp.write(cached_wav_bytes)
                wav_tmp.close()
                ref_path = wav_tmp.name
                temp_files.append(ref_path)
            else:
                ref_path, ref_text = self._process_voice_sample(ref_bytes, temp_files)
                
                # Cache the bytes, not the path — evict oldest if at capacity
                with open(ref_path, "rb") as f:
                    if len(self._ref_cache) >= self._ref_cache_max:
                        self._ref_cache.popitem(last=False)  # Remove oldest
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
                
                # Get emotion-specific speed with per-segment jitter
                emotion = emotions[i] if i < len(emotions) else 'neutral'
                emotion_speed = emotion_speeds.get(emotion, 1.0)
                
                # Per-segment micro-jitter (±2% for more natural variation)
                segment_jitter = 1.0 + random.uniform(-0.02, 0.02)
                segment_speed = requested_speed * emotion_speed * segment_jitter
                
                print(f"  Segment {i+1}/{len(segments)}: [{emotion}] {len(segment)} chars, speed={segment_speed:.2f}")
                
                with self._lock:
                    wav, sr, _ = self._get_model().infer(
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
            
            # Encode at native 24kHz — no wasteful upsampling
            audio_bytes = self._encode_audio(full_audio, sample_rate, audio_format, temp_files)
            
            return {
                "audio_base64": base64.b64encode(audio_bytes).decode("utf-8"),
                "format": audio_format,
                "size": len(audio_bytes),
                "sample_rate": sample_rate,
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
        
        # Convert to WAV (max 30 seconds)
        wav_path = raw_tmp.name.replace(".audio", "_converted.wav")
        
        cmd = [
            "ffmpeg", "-y", "-i", raw_tmp.name,
            "-ar", "24000", "-ac", "1",
            "-t", "30",  # Max 30 seconds
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
        
        # Transcribe reference audio with Whisper for better voice cloning
        # F5-TTS uses ref_text for phoneme alignment — empty ref_text degrades quality
        # BUT: ref_text must be short and accurate, or it causes content blending
        ref_text = ""
        try:
            if self._whisper is None:
                from faster_whisper import WhisperModel
                print("Loading Whisper model...")
                self._whisper = WhisperModel("base", device="cuda", compute_type="float16")
                print("Whisper loaded!")
            segments_iter, _ = self._whisper.transcribe(wav_path, language="en")
            ref_text = " ".join(seg.text.strip() for seg in segments_iter)
            # Limit ref_text to avoid conflation with gen_text
            words = ref_text.split()
            if len(words) > 30:
                ref_text = " ".join(words[:30])
            print(f"Whisper ref_text ({len(words)} words, trimmed to {len(ref_text.split())}): '{ref_text}'")
        except Exception as e:
            print(f"Whisper transcription failed, using empty ref_text: {e}")
            ref_text = ""
        
        return wav_path, ref_text

    def _encode_audio(self, audio_np, sr, fmt, temp_files):
        """Encode audio at native sample rate (24kHz). No upsampling."""
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


    @modal.fastapi_endpoint(method="POST")
    def generate_batch(self, request: dict):
        """
        Batch TTS: Process multiple text chunks in one request.
        Eliminates per-chunk network round trips and enables audio context
        between chunks for natural continuity.
        
        Request: {
            "texts": ["chunk1 text", "chunk2 text", ...],
            "reference_audio_base64": "...",
            "format": "mp3",
            "speed": 1.0,
            "jitter": 0.03,
            "context_seconds": 2.0  # seconds of previous chunk to use as context
        }
        
        Response: {
            "results": [
                {"audio_base64": "...", "size": N},
                {"audio_base64": "...", "size": N},
                ...
            ],
            "sample_rate": 24000
        }
        """
        import soundfile as sf
        import random
        
        texts = request.get("texts", [])
        ref_audio_b64 = request.get("reference_audio_base64", "")
        audio_format = request.get("format", "mp3")
        requested_speed = float(request.get("speed", 1.0))
        jitter_amount = float(request.get("jitter", 0.03))
        context_seconds = float(request.get("context_seconds", 2.0))
        # Per-text speeds from Emotion Director (overrides uniform speed + jitter)
        per_text_speeds = request.get("speeds", None)  # Optional: [0.92, 1.0, 1.15, ...]
        
        if not texts:
            return {"error": "texts array is required"}
        if not ref_audio_b64:
            return {"error": "reference_audio_base64 is required"}
        
        temp_files = []
        
        try:
            # Decode and process reference audio (cached)
            ref_bytes = base64.b64decode(ref_audio_b64)
            if len(ref_bytes) > 15 * 1024 * 1024:
                return {"error": "Voice sample too large. Max 15MB."}
            
            import hashlib
            ref_hash = hashlib.md5(ref_bytes).hexdigest()
            
            if ref_hash in self._ref_cache:
                cached_wav_bytes, ref_text = self._ref_cache.pop(ref_hash)  # pop to re-insert at end (LRU)
                self._ref_cache[ref_hash] = (cached_wav_bytes, ref_text)  # re-insert as most-recent
                wav_tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
                wav_tmp.write(cached_wav_bytes)
                wav_tmp.close()
                ref_path = wav_tmp.name
                temp_files.append(ref_path)
            else:
                ref_path, ref_text = self._process_voice_sample(ref_bytes, temp_files)
                with open(ref_path, "rb") as f:
                    if len(self._ref_cache) >= self._ref_cache_max:
                        self._ref_cache.popitem(last=False)  # Remove oldest
                    self._ref_cache[ref_hash] = (f.read(), ref_text)
            
            results = []
            prev_audio_np = None
            sample_rate = None
            
            # Emotion to speed mapping (same as generate endpoint)
            emotion_speeds_map = {
                'sarcasm': 1.0, 'dry_wit': 1.05, 'melancholy': 0.82,
                'resignation': 0.90, 'longing': 0.85, 'grief': 0.82,
                'sadness': 0.85, 'love': 0.90, 'anger': 1.15,
                'excitement': 1.15, 'fear': 0.88, 'joy': 1.10,
                'neutral': 1.0, 'amusement': 1.10, 'surprise': 1.13
            }
            
            for idx, text in enumerate(texts):
                text = text.strip()
                if not text:
                    results.append({"audio_base64": "", "size": 0, "error": "empty text"})
                    continue
                
                # Parse SML tags for pauses and emotion-based speed
                segments, pauses, emotions = self._parse_sml_tags(text)
                
                if not segments:
                    # No text after stripping SML tags — skip
                    results.append({"audio_base64": "", "size": 0, "error": "empty after SML parse"})
                    continue
                
                # Use per_text_speeds from Emotion Director as base if provided
                base_speed = float(per_text_speeds[idx]) if per_text_speeds and idx < len(per_text_speeds) else requested_speed
                
                # Generate audio for each SML segment within this text
                audio_segments = []
                for seg_idx, segment in enumerate(segments):
                    if not segment.strip():
                        continue
                    
                    # Determine speed: emotion tag overrides base speed
                    emotion = emotions[seg_idx] if seg_idx < len(emotions) else 'neutral'
                    emotion_speed = emotion_speeds_map.get(emotion, 1.0)
                    segment_jitter = 1.0 + random.uniform(-0.02, 0.02)
                    segment_speed = base_speed * emotion_speed * segment_jitter
                    
                    print(f"  Batch {idx+1}/{len(texts)} seg {seg_idx+1}/{len(segments)}: [{emotion}] {len(segment)} chars, speed={segment_speed:.2f}")
                    
                    with self._lock:
                        wav, sr, _ = self._get_model().infer(
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
                    
                    # Insert pause silence after this segment
                    if seg_idx < len(pauses):
                        pause_duration = pauses[seg_idx]
                        if pause_duration > 0:
                            pause_samples = int(pause_duration * sr)
                            silence = np.zeros(pause_samples, dtype=np.float32)
                            audio_segments.append(silence)
                            print(f"    Added {pause_duration}s pause")
                
                # Concatenate all segments for this text
                if not audio_segments:
                    results.append({"audio_base64": "", "size": 0, "error": "no audio generated"})
                    continue
                
                full_audio = np.concatenate(audio_segments)
                
                # Normalize
                max_val = np.abs(full_audio).max()
                if max_val > 0:
                    full_audio = full_audio / max_val * 0.95
                audio_np = full_audio.astype(np.float32)
                
                sample_rate = sr
                
                # Apply crossfade with previous chunk's tail for continuity
                if prev_audio_np is not None and context_seconds > 0:
                    crossfade_samples = int(0.05 * sr)  # 50ms crossfade
                    if len(prev_audio_np) > crossfade_samples and len(audio_np) > crossfade_samples:
                        fade_out = np.linspace(1.0, 0.0, crossfade_samples, dtype=np.float32)
                        fade_in = np.linspace(0.0, 1.0, crossfade_samples, dtype=np.float32)
                        
                        tail = prev_audio_np[-crossfade_samples:] * fade_out
                        head = audio_np[:crossfade_samples] * fade_in
                        
                        audio_np[:crossfade_samples] = tail + head
                
                # Encode this chunk
                audio_bytes = self._encode_audio(audio_np, sr, audio_format, temp_files)
                
                results.append({
                    "audio_base64": base64.b64encode(audio_bytes).decode("utf-8"),
                    "size": len(audio_bytes),
                })
                
                # Keep tail for next chunk's context
                context_samples = int(context_seconds * sr)
                prev_audio_np = audio_np[-context_samples:] if len(audio_np) > context_samples else audio_np
                
                print(f"  Batch {idx+1}/{len(texts)}: done ({len(audio_bytes)} bytes, {len(segments)} segments)")
            
            return {
                "results": results,
                "sample_rate": sample_rate or 24000,
                "batch_size": len(texts),
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


@app.function(image=image)
@modal.fastapi_endpoint(method="GET")
def health():
    import os
    return {
        "status": "ok", 
        "model": "f5-tts-v3",
        "features": ["batch", "whisper_ref_text", "crossfade_context", "native_24khz"],
        "cache_dir": os.path.exists("/root/.cache/huggingface/hub/models--SWivid--F5-TTS")
    }


@app.function(image=image, timeout=120)
@modal.fastapi_endpoint(method="POST")
def youtube_audio_download(request: dict):
    """
    Download audio from a YouTube video.
    Expects: { "video_id": "...", "start_time": 0, "end_time": 30 }
    Returns: { "audio_base64": "...", "format": "wav", "duration_seconds": N }
    """
    video_id = request.get("video_id", "").strip()
    start_time = float(request.get("start_time", 0))
    end_time = float(request.get("end_time", 30))
    
    if not video_id:
        return {"error": "video_id is required"}
    
    url = f"https://www.youtube.com/watch?v={video_id}"
    temp_files = []
    
    try:
        # Download best audio with yt-dlp
        import tempfile
        raw_path = tempfile.mktemp(suffix=".webm")
        temp_files.append(raw_path)
        
        subprocess.run([
            "yt-dlp", "-f", "bestaudio", "--no-video",
            "-o", raw_path, url
        ], capture_output=True, check=True, timeout=90)
        
        # Extract the requested time range and convert to 24kHz mono MP3
        # 24kHz mono matches F5-TTS input requirements — avoids wasteful 44.1kHz stereo WAV
        out_path = tempfile.mktemp(suffix=".mp3")
        temp_files.append(out_path)
        
        duration = end_time - start_time
        cmd = [
            "ffmpeg", "-y", "-i", raw_path,
            "-ss", str(start_time), "-t", str(duration),
            "-ac", "1", "-ar", "24000", "-b:a", "128k",
            out_path
        ]
        subprocess.run(cmd, capture_output=True, check=True)
        
        with open(out_path, "rb") as f:
            audio_bytes = f.read()
        
        return {
            "audio_base64": base64.b64encode(audio_bytes).decode(),
            "format": "mp3",
            "duration_seconds": duration,
            "size": len(audio_bytes)
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
