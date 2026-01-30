"""Flask web routes for server-side rendered pages"""
from flask import Blueprint, render_template, request, redirect, url_for, session, flash
from pathlib import Path
from werkzeug.utils import secure_filename
import uuid
import asyncio

from ..config import get_settings
from ..services import youtube

settings = get_settings()

# Create Flask blueprint
web = Blueprint('web', __name__, template_folder='../templates', static_folder='../static')


@web.route('/')
def index():
    """Redirect to PDF upload"""
    return redirect(url_for('web.upload_pdf'))


@web.route('/upload-pdf', methods=['GET', 'POST'])
def upload_pdf():
    """PDF upload page"""
    if request.method == 'POST':
        if 'pdf' not in request.files:
            flash('No PDF file uploaded', 'error')
            return redirect(request.url)

        file = request.files['pdf']
        if file.filename == '':
            flash('No file selected', 'error')
            return redirect(request.url)

        if not file.filename.lower().endswith('.pdf'):
            flash('Please upload a PDF file', 'error')
            return redirect(request.url)

        # Save PDF to temp directory
        filename = secure_filename(file.filename)
        file_id = str(uuid.uuid4())
        pdf_path = Path(settings.temp_dir) / 'pdfs' / f"{file_id}_{filename}"
        pdf_path.parent.mkdir(parents=True, exist_ok=True)

        file.save(str(pdf_path))

        # Store in session
        session['pdf_path'] = str(pdf_path)
        session['pdf_name'] = filename
        session['pdf_url'] = f"file:///{pdf_path.as_posix()}"

        flash('PDF uploaded successfully!', 'success')
        return redirect(url_for('web.voice_selection'))

    return render_template('upload_pdf.html', uploaded_file=None)


@web.route('/voice-selection')
def voice_selection():
    """Voice selection page with YouTube search"""
    search_query = request.args.get('q', '').strip()

    videos = []
    if search_query:
        try:
            # Call async YouTube search from sync Flask route
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            videos_list = loop.run_until_complete(
                youtube.search_videos(search_query, settings.youtube_api_key, max_results=10)
            )
            loop.close()
            videos = videos_list
        except Exception as e:
            flash(f'YouTube search error: {str(e)}', 'error')

    return render_template('voice_selection.html',
                           search_query=search_query,
                           videos=videos,
                           is_searching=False)


@web.route('/upload-audio', methods=['POST'])
def upload_audio():
    """Handle manual audio upload"""
    if 'audio' not in request.files:
        flash('No audio file uploaded', 'error')
        return redirect(url_for('web.voice_selection'))

    file = request.files['audio']
    if file.filename == '':
        flash('No file selected', 'error')
        return redirect(url_for('web.voice_selection'))

    # Check file size (50MB limit)
    file.seek(0, 2)  # Seek to end
    file_size = file.tell()
    file.seek(0)  # Reset to beginning

    max_size = 50 * 1024 * 1024  # 50MB
    if file_size > max_size:
        flash(f'File too large ({file_size / 1024 / 1024:.2f}MB). Maximum size is 50MB.', 'error')
        return redirect(url_for('web.voice_selection'))

    # Save audio file
    filename = secure_filename(file.filename)
    file_id = str(uuid.uuid4())
    file_ext = Path(filename).suffix
    audio_path = Path(settings.temp_dir) / 'samples' / f"{file_id}{file_ext}"
    audio_path.parent.mkdir(parents=True, exist_ok=True)

    file.save(str(audio_path))

    # Store in session
    session['audio_url'] = f"file:///{audio_path.as_posix()}"
    session['video_id'] = 'uploaded-audio'
    session['video_title'] = filename

    flash('Audio sample uploaded!', 'success')
    return redirect(url_for('web.voice_clipping'))


@web.route('/voice-clipping')
def voice_clipping():
    """Voice clipping page"""
    video_id = request.args.get('video_id') or session.get('video_id', '')
    video_title = request.args.get('title') or session.get('video_title', 'Unknown')
    audio_url = session.get('audio_url', '')

    if video_id:
        session['video_id'] = video_id
        session['video_title'] = video_title

    return render_template('voice_clipping.html',
                           video_id=video_id,
                           video_title=video_title,
                           audio_url=audio_url)


@web.route('/create-job', methods=['POST'])
def create_job():
    """Create audiobook generation job"""
    import httpx
    try:
        # Get form data
        video_id = request.form.get('video_id') or None
        audio_sample_url = request.form.get('audio_sample_url') or None
        start_time = float(request.form.get('start_time', 0))
        end_time = float(request.form.get('end_time', 60))

        # Get PDF from session
        pdf_url = session.get('pdf_url')
        pdf_name = session.get('pdf_name', 'document.pdf')

        if not pdf_url:
            flash('No PDF uploaded. Please start over.', 'error')
            return redirect(url_for('web.upload_pdf'))

        # Validate we have either video_id or audio_sample_url
        if not video_id and not audio_sample_url:
            flash('No voice sample selected. Please try again.', 'error')
            return redirect(url_for('web.voice_selection'))

        # Call the FastAPI queue endpoint to create the job
        api_base = f"http://localhost:{settings.port}/api"

        with httpx.Client(timeout=30.0) as client:
            response = client.post(
                f"{api_base}/queue/create",
                json={
                    "pdf_url": pdf_url,
                    "video_id": video_id,
                    "audio_sample_url": audio_sample_url,
                    "start_time": start_time,
                    "end_time": end_time
                }
            )

            if response.status_code != 200:
                error_detail = response.json().get('detail', 'Unknown error')
                raise Exception(f"API error: {error_detail}")

            result = response.json()
            job_id = result['job_id']

        flash(f'Audiobook job created successfully! Job ID: {job_id}', 'success')
        return redirect(url_for('web.queue_page'))

    except Exception as e:
        flash(f'Failed to create job: {str(e)}', 'error')
        return redirect(url_for('web.voice_clipping'))


@web.route('/queue')
def queue_page():
    """Queue status page"""
    import httpx
    jobs = []

    try:
        # Fetch jobs from the API
        api_base = f"http://localhost:{settings.port}/api"

        with httpx.Client(timeout=10.0) as client:
            response = client.get(f"{api_base}/queue/jobs")

            if response.status_code == 200:
                result = response.json()
                # Transform API response to match template expectations
                for job in result.get('jobs', []):
                    jobs.append({
                        'id': job['job_id'],
                        'pdf_name': 'Document.pdf',  # Not stored in Redis yet
                        'voice_name': 'Voice Sample',  # Not stored in Redis yet
                        'status': job['status'],
                        'progress': job['progress'],
                        'error': job.get('error'),
                        'audio_url': job.get('audio_url')
                    })
    except Exception as e:
        flash(f'Error fetching jobs: {str(e)}', 'error')

    return render_template('queue.html', jobs=jobs)


@web.route('/player/<job_id>')
def player(job_id):
    """Audio player page (placeholder for now)"""
    flash('Audio player coming soon!', 'info')
    return redirect(url_for('web.queue_page'))


# Error handlers removed - they were interfering with other blueprints
