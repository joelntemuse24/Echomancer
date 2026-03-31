import modal
import base64
import os
import tempfile
import subprocess
import numpy as np

app = modal.App("audio-cleaner")

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg")
    .pip_install(
        "torch>=2.1.0",
        "torchaudio",
        "demucs",
        "silero-vad",
        "pydub",
        "numpy",
        "fastapi"
    )
)

@app.cls(gpu="L4", image=image, timeout=300, scaledown_window=300)
class AudioCleaner:
    @modal.enter()
    def setup(self):
        import torch
        from demucs.pretrained import get_model
        from silero_vad import load_silero_vad
        
        print("Loading Demucs model...")
        self.demucs_model = get_model('htdemucs')
        self.demucs_model.cuda()
        self.demucs_model.eval()
        
        print("Loading Silero VAD model...")
        self.vad_model = load_silero_vad()

    @modal.fastapi_endpoint(method="POST")
    def clean(self, request: dict):
        """
        Expects: { "audio_base64": "..." }
        Returns: { "audio_base64": "...", "format": "wav" }
        """
        audio_b64 = request.get("audio_base64", "")
        if not audio_b64:
            return {"error": "audio_base64 is required"}
            
        temp_files = []
        try:
            audio_bytes = base64.b64decode(audio_b64)
            
            # 1. Save input audio
            with tempfile.NamedTemporaryFile(suffix=".audio", delete=False) as f:
                f.write(audio_bytes)
                input_path = f.name
            temp_files.append(input_path)
            
            # 2. Truncate to first 60 seconds to prevent OOM / timeouts
            truncated_path = input_path + "_trunc.wav"
            subprocess.run([
                "ffmpeg", "-y", "-i", input_path,
                "-t", "60", "-ac", "1", "-ar", "44100",
                truncated_path
            ], capture_output=True, check=True)
            temp_files.append(truncated_path)
            
            # 3. Demucs: Isolate Vocals
            out_dir = tempfile.mkdtemp()
            subprocess.run([
                "demucs", "-n", "htdemucs", "--two-stems", "vocals", 
                "--out", out_dir, truncated_path
            ], capture_output=True, check=True)
            
            # Demucs output path structure: out_dir/htdemucs/filename/vocals.wav
            base_name = os.path.splitext(os.path.basename(truncated_path))[0]
            vocals_path = os.path.join(out_dir, "htdemucs", base_name, "vocals.wav")
            temp_files.append(vocals_path)
            
            if not os.path.exists(vocals_path):
                return {"error": "Demucs failed to extract vocals"}
                
            # 4. Silero VAD: Find Speech Segments
            import torch
            import torchaudio
            from silero_vad import get_speech_timestamps
            
            wav, sr = torchaudio.load(vocals_path)
            # Silero VAD expects 16kHz
            if sr != 16000:
                resampler = torchaudio.transforms.Resample(sr, 16000)
                wav_16k = resampler(wav)
            else:
                wav_16k = wav
                
            # get timestamps
            wav_16k = wav_16k.mean(dim=0) # mono
            speech_timestamps = get_speech_timestamps(wav_16k, self.vad_model, return_seconds=True)
            
            if not speech_timestamps:
                return {"error": "No speech detected in the audio"}
                
            # 5. Extract and combine ~10-12 seconds of pure speech
            from pydub import AudioSegment
            full_vocals = AudioSegment.from_wav(vocals_path)
            
            golden_clip = AudioSegment.empty()
            target_length_ms = 12000 # 12 seconds
            
            for ts in speech_timestamps:
                start_ms = int(ts['start'] * 1000)
                end_ms = int(ts['end'] * 1000)
                
                segment = full_vocals[start_ms:end_ms]
                golden_clip += segment
                # Add 0.2s pause between segments for natural flow if we append more
                golden_clip += AudioSegment.silent(duration=200) 
                
                if len(golden_clip) >= target_length_ms:
                    break
                    
            # Trim to max 12 seconds
            if len(golden_clip) > target_length_ms:
                golden_clip = golden_clip[:target_length_ms]
                
            # 6. Normalize Volume
            # Standardize loudness so TTS always gets consistent input volume
            golden_clip = golden_clip.normalize()
            
            # Export final
            final_path = input_path + "_final.wav"
            temp_files.append(final_path)
            golden_clip.export(final_path, format="wav", parameters=["-ar", "24000", "-ac", "1"])
            
            with open(final_path, "rb") as f:
                final_bytes = f.read()
                
            return {
                "audio_base64": base64.b64encode(final_bytes).decode(),
                "format": "wav",
                "size": len(final_bytes)
            }
            
        except subprocess.CalledProcessError as e:
            return {"error": f"Subprocess error: {e.stderr.decode()}"}
        except Exception as e:
            import traceback
            return {"error": str(e), "traceback": traceback.format_exc()}
        finally:
            for f in temp_files:
                if os.path.exists(f):
                    try:
                        os.remove(f)
                    except:
                        pass
