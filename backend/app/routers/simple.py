"""
SIMPLE Audiobook Generator - No queues, no CDN, no complexity.
Just upload files → get audiobook. That's it.
"""

from flask import Blueprint, render_template, request, send_file, flash, redirect, url_for
from pathlib import Path
from werkzeug.utils import secure_filename
import uuid
import tempfile
import shutil

from ..config import get_settings
from ..services import pdf as pdf_service

settings = get_settings()

simple = Blueprint('simple', __name__, template_folder='../templates')


@simple.route('/')
def index():
    """Simple one-page audiobook generator"""
    return render_template('simple.html')


@simple.route('/generate', methods=['POST'])
def generate():
    """
    Generate audiobook synchronously - no queues, no CDN, just direct processing.
    """
    # Create a temp directory for this job
    job_id = str(uuid.uuid4())[:8]
    job_dir = Path(tempfile.gettempdir()) / 'echomancer' / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    
    try:
        # 1. Get uploaded files
        if 'pdf' not in request.files:
            flash('Please upload a PDF file', 'error')
            return redirect(url_for('simple.index'))
        
        # Audio is optional if voice_id is provided
        existing_voice_id = request.form.get('voice_id', '').strip()
        if 'audio' not in request.files and not existing_voice_id:
            flash('Please upload an audio sample or provide a Voice ID', 'error')
            return redirect(url_for('simple.index'))
        
        pdf_file = request.files['pdf']
        audio_file = request.files.get('audio')
        
        if pdf_file.filename == '':
            flash('Please select a PDF file', 'error')
            return redirect(url_for('simple.index'))
        
        # Audio file is optional if voice_id provided
        if not existing_voice_id and (not audio_file or audio_file.filename == ''):
            flash('Please upload an audio sample or provide a Voice ID', 'error')
            return redirect(url_for('simple.index'))
        
        # 2. Save files locally
        pdf_path = job_dir / 'input.pdf'
        pdf_file.save(str(pdf_path))
        
        audio_path = None
        if audio_file and audio_file.filename:
            audio_path = job_dir / f'voice_sample{Path(audio_file.filename).suffix}'
            audio_file.save(str(audio_path))
        
        # 3. Extract text from PDF
        try:
            text = pdf_service.extract_text_from_file(pdf_path)
            if not text.strip():
                flash('Could not extract text from PDF. Is it a scanned document?', 'error')
                return redirect(url_for('simple.index'))
        except Exception as e:
            flash(f'PDF error: {str(e)}', 'error')
            return redirect(url_for('simple.index'))
        
        # Split text into chunks based on provider
        # Chatterbox: 500 chars max (GPU memory safe)
        # Replicate/Minimax: 8000 chars max (API limit)
        if settings.tts_provider == 'chatterbox':
            MAX_CHUNK_SIZE = 500
        else:
            MAX_CHUNK_SIZE = 8000
        
        def split_into_chunks(text, max_size):
            """Split text into chunks at sentence boundaries."""
            import re
            chunks = []
            current_chunk = ""
            
            sentences = re.split(r'(?<=[.!?])\s+', text.replace('\n', ' '))
            
            for sentence in sentences:
                if len(sentence) > max_size:
                    if current_chunk:
                        chunks.append(current_chunk.strip())
                        current_chunk = ""
                    words = sentence.split()
                    temp = ""
                    for word in words:
                        if len(temp) + len(word) + 1 <= max_size:
                            temp += word + " "
                        else:
                            if temp:
                                chunks.append(temp.strip())
                            temp = word + " "
                    if temp:
                        chunks.append(temp.strip())
                    continue
                
                if len(current_chunk) + len(sentence) + 1 <= max_size:
                    current_chunk += sentence + " "
                else:
                    if current_chunk:
                        chunks.append(current_chunk.strip())
                    current_chunk = sentence + " "
            
            if current_chunk:
                chunks.append(current_chunk.strip())
            
            return chunks
        
        text_chunks = split_into_chunks(text, MAX_CHUNK_SIZE)
        total_chunks = len(text_chunks)
        
        # 4. Generate audio using TTS
        output_path = job_dir / 'audiobook.wav'
        audio_chunks = []  # Store paths to audio chunk files
        
        if settings.tts_provider == 'chatterbox':
            # ===== CHATTERBOX TTS (Local GPU) =====
            # Zero-shot voice cloning from reference audio, no API costs
            # Supports [laugh], [sigh], [gasp] tags in text
            try:
                if not audio_path:
                    flash('Chatterbox requires a voice sample audio file for cloning', 'error')
                    return redirect(url_for('simple.index'))
                
                import torch
                import torchaudio
                from chatterbox.tts import ChatterboxTTS
                
                # Load model (singleton pattern for reuse across requests)
                if not hasattr(generate, '_chatterbox_model') or generate._chatterbox_model is None:
                    device = settings.chatterbox_device
                    print(f"Loading Chatterbox TTS model on {device}...")
                    generate._chatterbox_model = ChatterboxTTS.from_pretrained(device=device)
                    print("Chatterbox TTS model loaded!")
                
                model = generate._chatterbox_model
                
                for i, chunk_text in enumerate(text_chunks):
                    print(f"[Chatterbox] Processing chunk {i+1}/{total_chunks} ({len(chunk_text)} chars)")
                    
                    wav = model.generate(
                        text=chunk_text,
                        audio_prompt_path=str(audio_path),
                        exaggeration=settings.chatterbox_exaggeration,
                        cfg_weight=settings.chatterbox_cfg_weight,
                    )
                    
                    chunk_path = job_dir / f'chunk_{i}.wav'
                    torchaudio.save(str(chunk_path), wav, model.sr)
                    audio_chunks.append(chunk_path)
                    
                    # Free GPU memory between chunks
                    torch.cuda.empty_cache()
                
                # Combine chunks
                if len(audio_chunks) == 1:
                    output_path = audio_chunks[0]
                else:
                    # Concatenate WAV files using torchaudio
                    all_wavs = []
                    for chunk_path in audio_chunks:
                        wav_data, sr = torchaudio.load(str(chunk_path))
                        all_wavs.append(wav_data)
                    
                    combined = torch.cat(all_wavs, dim=1)
                    output_path = job_dir / 'audiobook.wav'
                    torchaudio.save(str(output_path), combined, sr)
                    
            except ImportError:
                flash('Chatterbox TTS not installed. Run: pip install chatterbox-tts', 'error')
                return redirect(url_for('simple.index'))
            except Exception as e:
                flash(f'Chatterbox error: {str(e)}', 'error')
                return redirect(url_for('simple.index'))
                
        elif settings.tts_provider == 'replicate' and settings.replicate_api_token:
            # ===== REPLICATE API (Cloud fallback) =====
            import replicate
            import base64
            import os
            
            os.environ["REPLICATE_API_TOKEN"] = settings.replicate_api_token
            
            try:
                # Check if user provided an existing voice_id (to skip $3 cloning fee)
                if existing_voice_id:
                    voice_id = existing_voice_id
                else:
                    if not audio_path:
                        flash('Please upload an audio sample to clone a new voice', 'error')
                        return redirect(url_for('simple.index'))
                    
                    ext = audio_path.suffix.lower()
                    if ext not in ['.mp3', '.m4a', '.wav']:
                        flash(f'Minimax requires MP3, M4A, or WAV files. You uploaded: {ext}', 'error')
                        return redirect(url_for('simple.index'))
                    
                    audio_bytes = audio_path.read_bytes()
                    audio_b64 = base64.b64encode(audio_bytes).decode('utf-8')
                    mime_types = {'.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav'}
                    mime_type = mime_types.get(ext, 'audio/mpeg')
                    data_uri = f"data:{mime_type};name=voice{ext};base64,{audio_b64}"
                    
                    clone_output = replicate.run(
                        "minimax/voice-cloning",
                        input={
                            "voice_file": data_uri,
                            "model": "speech-02-turbo"
                        }
                    )
                    
                    voice_id = clone_output.get("voice_id") if isinstance(clone_output, dict) else clone_output["voice_id"]
                    
                    voice_id_file = Path(__file__).parent.parent.parent / "voice_ids.txt"
                    with open(voice_id_file, "a") as f:
                        from datetime import datetime
                        f.write(f"{datetime.now().isoformat()} - {voice_id}\n")
                    
                    flash(f'Voice cloned! ID saved: {voice_id}', 'success')
                
                import httpx
                
                for i, chunk_text in enumerate(text_chunks):
                    print(f"[Replicate] Processing chunk {i+1}/{total_chunks} ({len(chunk_text)} chars)")
                    
                    output = replicate.run(
                        "minimax/speech-02-turbo",
                        input={
                            "text": chunk_text,
                            "voice_id": voice_id,
                        }
                    )
                    
                    if hasattr(output, 'url'):
                        audio_url = output.url
                    elif hasattr(output, 'read'):
                        chunk_path = job_dir / f'chunk_{i}.mp3'
                        chunk_path.write_bytes(output.read())
                        audio_chunks.append(chunk_path)
                        continue
                    else:
                        audio_url = str(output)
                    
                    if audio_url:
                        with httpx.Client(timeout=300.0) as client:
                            response = client.get(audio_url)
                            response.raise_for_status()
                            chunk_path = job_dir / f'chunk_{i}.mp3'
                            chunk_path.write_bytes(response.content)
                            audio_chunks.append(chunk_path)
                
                if len(audio_chunks) == 1:
                    output_path = audio_chunks[0]
                else:
                    combined_audio = b''
                    for chunk_path in audio_chunks:
                        combined_audio += chunk_path.read_bytes()
                    output_path = job_dir / 'audiobook.mp3'
                    output_path.write_bytes(combined_audio)
                    
            except Exception as e:
                flash(f'Replicate error: {str(e)}', 'error')
                return redirect(url_for('simple.index'))
        else:
            flash('TTS not configured. Set TTS_PROVIDER=chatterbox (GPU) or TTS_PROVIDER=replicate (cloud) in .env', 'error')
            return redirect(url_for('simple.index'))
        
        # 5. Return the audio file
        if output_path.exists():
            # Detect mime type from extension
            ext = output_path.suffix.lower()
            mimetype = 'audio/mpeg' if ext == '.mp3' else 'audio/wav'
            return send_file(
                str(output_path),
                mimetype=mimetype,
                as_attachment=True,
                download_name=f'audiobook_{job_id}{ext}'
            )
        else:
            flash('Audio generation failed - no output file created', 'error')
            return redirect(url_for('simple.index'))
            
    except Exception as e:
        flash(f'Error: {str(e)}', 'error')
        return redirect(url_for('simple.index'))
    finally:
        # Cleanup after sending (Flask handles this)
        pass


@simple.route('/test')
def test_tts():
    """Test if TTS is configured and working"""
    result = {
        'tts_provider': settings.tts_provider,
        'replicate_token': 'Set' if settings.replicate_api_token else 'Not set',
    }
    
    if settings.tts_provider == 'chatterbox':
        result['chatterbox_device'] = settings.chatterbox_device
        result['chatterbox_exaggeration'] = settings.chatterbox_exaggeration
        result['chatterbox_cfg_weight'] = settings.chatterbox_cfg_weight
        # Check if torch/CUDA available
        try:
            import torch
            result['cuda_available'] = torch.cuda.is_available()
            if torch.cuda.is_available():
                result['gpu_name'] = torch.cuda.get_device_name(0)
                result['gpu_memory_gb'] = round(torch.cuda.get_device_properties(0).total_mem / 1e9, 1)
        except ImportError:
            result['cuda_available'] = 'torch not installed'
        # Check if chatterbox installed
        try:
            from chatterbox.tts import ChatterboxTTS
            result['chatterbox_installed'] = True
        except ImportError:
            result['chatterbox_installed'] = False
    
    if settings.vastai_url:
        result['vastai_url'] = settings.vastai_url
        import httpx
        try:
            with httpx.Client(timeout=5.0) as client:
                response = client.get(f"{settings.vastai_url}/health")
                result['vastai_status'] = 'Connected' if response.status_code == 200 else f'Error: {response.status_code}'
        except Exception as e:
            result['vastai_status'] = f'Cannot connect: {str(e)}'
    
    return result
