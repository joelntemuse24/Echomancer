"""
F5-TTS Server on Modal.
High-fidelity voice cloning TTS as a serverless GPU endpoint.
Scales to zero when idle — you only pay for GPU seconds used.
"""

import modal

app = modal.App("f5-tts")

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
    )
)


@app.cls(
    gpu="A10G",
    image=image,
    scaledown_window=300,
    timeout=600,
)
@modal.concurrent(max_inputs=1)
class F5TTSServer:
    @modal.enter()
    def load_model(self):
        """Load F5-TTS + Whisper into GPU memory when container boots."""
        import torch

        print("Loading F5-TTS model...")
        from f5_tts.api import F5TTS
        self.tts = F5TTS(device="cuda")
        print("F5-TTS loaded!")

        print("Loading Whisper for auto-transcription...")
        import whisper
        self.whisper_model = whisper.load_model("small", device="cuda")
        print("Whisper loaded! Ready to serve.")

        # Cache for transcribed reference audio (avoid re-transcribing same clip)
        self._ref_cache = {}

    @modal.fastapi_endpoint(method="POST")
    def generate(self, request: dict):
        """
        Generate TTS audio with voice cloning.
        Accepts JSON: { "text": "...", "reference_audio_base64": "...", "format": "mp3" }
        Returns JSON: { "audio_base64": "...", "format": "mp3", "size": N }
        """
        import base64
        import io
        import os
        import tempfile
        import subprocess
        import soundfile as sf
        import numpy as np

        text = request.get("text", "")
        ref_audio_b64 = request.get("reference_audio_base64", "")
        audio_format = request.get("format", "mp3")

        if not text:
            return {"error": "text is required"}

        try:
            import hashlib

            # Save and convert reference audio to WAV
            ref_path = None
            ref_text = ""
            if ref_audio_b64:
                ref_bytes = base64.b64decode(ref_audio_b64)

                # Check cache — skip transcription if we've seen this audio before
                ref_hash = hashlib.md5(ref_bytes[:10000]).hexdigest()

                raw_tmp = tempfile.NamedTemporaryFile(suffix=".audio", delete=False)
                raw_tmp.write(ref_bytes)
                raw_tmp.close()

                # Convert to proper WAV + trim to 15 seconds max
                # F5-TTS works best with 5-15s of clean reference audio
                wav_path = raw_tmp.name.replace(".audio", "_converted.wav")
                result = subprocess.run(
                    ["ffmpeg", "-i", raw_tmp.name, "-ar", "24000", "-ac", "1",
                     "-t", "15", "-y", wav_path],
                    capture_output=True, timeout=30,
                )
                os.unlink(raw_tmp.name)

                if result.returncode != 0:
                    return {"error": f"Failed to convert reference audio: {result.stderr.decode()}"}

                ref_path = wav_path
                print(f"Reference audio converted (trimmed to 15s max): {os.path.getsize(wav_path)} bytes")

                # Use cached transcription if available
                if ref_hash in self._ref_cache:
                    ref_text = self._ref_cache[ref_hash]
                    print(f"Using cached transcription: '{ref_text[:200]}'")
                else:
                    # Auto-transcribe reference audio with Whisper
                    # Force English to prevent wrong language detection
                    print("Transcribing reference audio...")
                    whisper_result = self.whisper_model.transcribe(wav_path, language="en")
                    ref_text = whisper_result["text"].strip()
                    self._ref_cache[ref_hash] = ref_text
                    print(f"Transcription: '{ref_text[:200]}'")

            # Generate audio — speed 0.85 for natural narration pace
            print(f"Generating TTS for {len(text)} chars...")
            wav, sr, _ = self.tts.infer(
                ref_file=ref_path or "",
                ref_text=ref_text,
                gen_text=text,
                speed=0.85,
            )

            # Clean up ref file
            if ref_path:
                os.unlink(ref_path)

            # Convert to numpy array
            if hasattr(wav, 'numpy'):
                audio_np = wav.squeeze().cpu().numpy()
            elif hasattr(wav, 'cpu'):
                audio_np = wav.squeeze().cpu().numpy()
            else:
                audio_np = np.array(wav).squeeze()

            # Normalize audio to prevent clipping/scratchy artifacts
            max_val = np.abs(audio_np).max()
            if max_val > 0:
                audio_np = audio_np / max_val * 0.95  # Leave headroom

            # Ensure float32
            audio_np = audio_np.astype(np.float32)

            # Write WAV to buffer
            wav_buf = io.BytesIO()
            sf.write(wav_buf, audio_np, sr, format="WAV", subtype="FLOAT")
            wav_buf.seek(0)

            # Convert to MP3 if needed
            if audio_format == "mp3":
                wav_tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
                wav_tmp.write(wav_buf.read())
                wav_tmp.close()

                mp3_path = wav_tmp.name.replace(".wav", ".mp3")
                subprocess.run(
                    ["ffmpeg", "-i", wav_tmp.name, "-b:a", "192k", "-y", mp3_path],
                    capture_output=True, timeout=60,
                )

                with open(mp3_path, "rb") as f:
                    audio_bytes = f.read()

                os.unlink(wav_tmp.name)
                os.unlink(mp3_path)
            else:
                audio_bytes = wav_buf.read()

            return {
                "audio_base64": base64.b64encode(audio_bytes).decode("utf-8"),
                "format": audio_format,
                "size": len(audio_bytes),
            }

        except Exception as e:
            import traceback
            return {"error": str(e), "traceback": traceback.format_exc()}
