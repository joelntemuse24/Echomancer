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
        
        # Split text into chunks (Minimax limit is 10000 chars)
        MAX_CHUNK_SIZE = 8000  # Leave buffer
        
        def split_into_chunks(text, max_size):
            """Split text into chunks at sentence boundaries."""
            chunks = []
            current_chunk = ""
            
            # Split by sentences (roughly)
            sentences = text.replace('\n', ' ').split('. ')
            
            for sentence in sentences:
                if len(current_chunk) + len(sentence) + 2 < max_size:
                    current_chunk += sentence + ". "
                else:
                    if current_chunk:
                        chunks.append(current_chunk.strip())
                    current_chunk = sentence + ". "
            
            if current_chunk:
                chunks.append(current_chunk.strip())
            
            return chunks
        
        text_chunks = split_into_chunks(text, MAX_CHUNK_SIZE)
        total_chunks = len(text_chunks)
        
        # 4. Generate audio using TTS
        output_path = job_dir / 'audiobook.wav'
        audio_chunks = []  # Store paths to audio chunk files
        
        if settings.tts_provider == 'vastai' and settings.vastai_url:
            # Call Vast.ai F5-TTS server
            import httpx
            try:
                with httpx.Client(timeout=300.0) as client:
                    # Upload voice sample first
                    with open(audio_path, 'rb') as f:
                        files = {'file': (audio_path.name, f, 'audio/mpeg')}
                        # Check if server is up
                        health = client.get(f"{settings.vastai_url}/health")
                        if health.status_code != 200:
                            raise Exception("Vast.ai server not responding")
                    
                    # For now, we need the audio accessible via URL
                    # Let's use a simple base64 approach or direct file
                    import base64
                    audio_b64 = base64.b64encode(audio_path.read_bytes()).decode()
                    
                    response = client.post(
                        f"{settings.vastai_url}/generate",
                        json={
                            "text": text,
                            "voice_sample_base64": audio_b64,
                            "ref_text": ""
                        },
                        timeout=300.0
                    )
                    
                    if response.status_code == 200:
                        output_path.write_bytes(response.content)
                    else:
                        raise Exception(f"TTS error: {response.text}")
                        
            except httpx.ConnectError:
                flash('Cannot connect to Vast.ai server. Is it running?', 'error')
                return redirect(url_for('simple.index'))
            except Exception as e:
                flash(f'TTS error: {str(e)}', 'error')
                return redirect(url_for('simple.index'))
                
        elif settings.tts_provider == 'replicate' and settings.replicate_api_token:
            # Use Replicate API with Minimax Speech-02-HD
            import replicate
            import base64
            import os
            
            # Set the API token for Replicate
            os.environ["REPLICATE_API_TOKEN"] = settings.replicate_api_token
            
            try:
                # Check if user provided an existing voice_id (to skip $3 cloning fee)
                if existing_voice_id:
                    # Reuse existing voice - no cloning charge!
                    voice_id = existing_voice_id
                else:
                    # Need audio file to clone voice
                    if not audio_path:
                        flash('Please upload an audio sample to clone a new voice', 'error')
                        return redirect(url_for('simple.index'))
                    
                    # Check file extension - Minimax only accepts mp3, m4a, wav
                    ext = audio_path.suffix.lower()
                    if ext not in ['.mp3', '.m4a', '.wav']:
                        flash(f'Minimax requires MP3, M4A, or WAV files. You uploaded: {ext}', 'error')
                        return redirect(url_for('simple.index'))
                    
                    # Use data URI format
                    audio_bytes = audio_path.read_bytes()
                    audio_b64 = base64.b64encode(audio_bytes).decode('utf-8')
                    mime_types = {'.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav'}
                    mime_type = mime_types.get(ext, 'audio/mpeg')
                    
                    # Create data URI with filename hint
                    data_uri = f"data:{mime_type};name=voice{ext};base64,{audio_b64}"
                    
                    # Step 1: Clone the voice using Minimax ($3 one-time)
                    clone_output = replicate.run(
                        "minimax/voice-cloning",
                        input={
                            "voice_file": data_uri,
                            "model": "speech-02-turbo"
                        }
                    )
                    
                    # Get the voice_id from clone output
                    voice_id = clone_output.get("voice_id") if isinstance(clone_output, dict) else clone_output["voice_id"]
                    
                    # Save voice_id to file so user can retrieve it
                    voice_id_file = Path(__file__).parent.parent.parent / "voice_ids.txt"
                    with open(voice_id_file, "a") as f:
                        from datetime import datetime
                        f.write(f"{datetime.now().isoformat()} - {voice_id}\n")
                    
                    # Also flash it to the page (but page redirects, so save to file is more reliable)
                    flash(f'Voice cloned! ID saved to voice_ids.txt: {voice_id}', 'success')
                
                # Step 2: Generate speech for each chunk
                import httpx
                
                for i, chunk_text in enumerate(text_chunks):
                    print(f"Processing chunk {i+1}/{total_chunks} ({len(chunk_text)} chars)")
                    
                    output = replicate.run(
                        "minimax/speech-02-turbo",
                        input={
                            "text": chunk_text,
                            "voice_id": voice_id,
                        }
                    )
                    
                    # Download result
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
                
                # Combine all chunks into one file
                if len(audio_chunks) == 1:
                    # Only one chunk, just rename it
                    output_path = audio_chunks[0]
                else:
                    # Multiple chunks - concatenate them
                    combined_audio = b''
                    for chunk_path in audio_chunks:
                        combined_audio += chunk_path.read_bytes()
                    output_path = job_dir / 'audiobook.mp3'
                    output_path.write_bytes(combined_audio)
                    
            except Exception as e:
                flash(f'Replicate error: {str(e)}', 'error')
                return redirect(url_for('simple.index'))
        else:
            # Mock mode - just return a message
            flash('TTS not configured. Set VASTAI_URL or REPLICATE_API_TOKEN in .env', 'error')
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
        'vastai_url': settings.vastai_url or 'Not configured',
        'replicate_token': 'Set' if settings.replicate_api_token else 'Not set',
    }
    
    # Test Vast.ai connection if configured
    if settings.vastai_url:
        import httpx
        try:
            with httpx.Client(timeout=5.0) as client:
                response = client.get(f"{settings.vastai_url}/health")
                result['vastai_status'] = 'Connected' if response.status_code == 200 else f'Error: {response.status_code}'
        except Exception as e:
            result['vastai_status'] = f'Cannot connect: {str(e)}'
    
    return result
