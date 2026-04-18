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
        "torch==2.4.0",
        "torchaudio==2.4.0",
        "demucs",
        "silero-vad",
        "pydub",
        "numpy",
        "fastapi"
    )
    # Note: torchcodec removed to avoid CUDA library dependency issues
    # (libnppicc.so.13 errors). Audio cleaner works without it.
)

@app.cls(gpu="T4", image=image, timeout=300, scaledown_window=300)
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
    def enhance_audiobook(self, request: dict):
        """
        Expects: { "audio_base64": "..." }
        Returns: { "audio_base64": "...", "format": "mp3" }
        Post-processes a compiled audiobook to smooth it out, remove clicks, normalize volume, etc.
        """
        audio_b64 = request.get("audio_base64", "")
        if not audio_b64:
            return {"error": "audio_base64 is required"}
            
        temp_files = []
        try:
            audio_bytes = base64.b64decode(audio_b64)
            
            with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
                f.write(audio_bytes)
                input_path = f.name
            temp_files.append(input_path)
            
            from pydub import AudioSegment
            import pydub.effects
            
            # Load the audio (this decodes the mp3)
            audio = AudioSegment.from_file(input_path)
            
            # 1. Normalize the audio to standard volume (-3 dBFS is common for audiobooks)
            # pydub's normalize brings the peak volume to 0 dBFS by default, we can set headroom
            audio = pydub.effects.normalize(audio)
            
            # 2. Apply a mild low-pass and high-pass filter to remove rumble and harsh hiss
            audio = audio.high_pass_filter(80)   # Remove sub-bass rumble
            audio = audio.low_pass_filter(10000) # Remove extremely harsh high-end hiss
            
            # 3. Apply mild compression to even out volume levels
            audio = pydub.effects.compress_dynamic_range(
                audio,
                threshold=-20.0, # dBFS
                ratio=2.0,
                attack=5.0,
                release=50.0
            )
            
            # Export the cleaned audio back to mp3
            final_path = input_path + "_enhanced.mp3"
            temp_files.append(final_path)
            
            audio.export(final_path, format="mp3", bitrate="128k", parameters=["-ar", "24000", "-ac", "1"])
            
            with open(final_path, "rb") as f:
                final_bytes = f.read()
                
            return {
                "audio_base64": base64.b64encode(final_bytes).decode(),
                "format": "mp3",
                "size": len(final_bytes)
            }
            
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
            
            # 2. Truncate to first 180 seconds to give plenty of material
            truncated_path = input_path + "_trunc.wav"
            subprocess.run([
                "ffmpeg", "-y", "-i", input_path,
                "-t", "180", "-ac", "1", "-ar", "44100",
                truncated_path
            ], capture_output=True, check=True)
            temp_files.append(truncated_path)
            
            # 3. Demucs: Isolate Vocals (using loaded model directly, not CLI)
            import torch
            import torchaudio
            from demucs.apply import apply_model
            
            wav_tensor, sr_orig = torchaudio.load(truncated_path)
            # Demucs expects stereo at 44100Hz
            if sr_orig != 44100:
                wav_tensor = torchaudio.functional.resample(wav_tensor, sr_orig, 44100)
            if wav_tensor.shape[0] == 1:
                wav_tensor = wav_tensor.repeat(2, 1)
            
            # Run Demucs model directly on GPU
            with torch.no_grad():
                sources = apply_model(self.demucs_model, wav_tensor.unsqueeze(0).cuda(), split=True)
            
            # sources shape: [1, num_sources, channels, samples]
            # htdemucs sources order: drums, bass, other, vocals (index 3)
            vocals_tensor = sources[0, 3]  # [channels, samples]
            
            # Save vocals to temp file
            vocals_path = truncated_path + "_vocals.wav"
            torchaudio.save(vocals_path, vocals_tensor.cpu(), 44100)
            temp_files.append(vocals_path)
                
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
                
            # 5. Extract and combine up to 60 seconds of pure speech
            # Longer reference = more phoneme diversity = better voice cloning
            from pydub import AudioSegment
            full_vocals = AudioSegment.from_wav(vocals_path)
            
            golden_clip = AudioSegment.empty()
            target_length_ms = 60000 # 60 seconds
            
            for ts in speech_timestamps:
                start_ms = int(ts['start'] * 1000)
                end_ms = int(ts['end'] * 1000)
                
                segment = full_vocals[start_ms:end_ms]
                golden_clip += segment
                # Add 0.2s pause between segments for natural flow if we append more
                golden_clip += AudioSegment.silent(duration=200) 
                
                if len(golden_clip) >= target_length_ms:
                    break
                    
            # Trim to max 60 seconds
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
