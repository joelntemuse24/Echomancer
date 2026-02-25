"""
Echomancer Backend - FastAPI + Flask Application

PDF to Audiobook converter using Fish Speech voice cloning.
"""

from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.wsgi import WSGIMiddleware
from flask import Flask
from pathlib import Path
import os

from .config import get_settings
from .routers import pdf, youtube, audio, queue, health
from .routers import stripe_payment
from .routers.web import web as flask_web_blueprint
from .routers.simple import simple as flask_simple_blueprint

# Create FastAPI app
app = FastAPI(
    title="Echomancer API",
    description="Transform PDFs into audiobooks with custom AI voices",
    version="0.2.0",
)

# Get settings
settings = get_settings()

# CORS middleware for API endpoints
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        settings.frontend_url,
        "http://localhost:3000",
        "http://localhost:5173",  # Vite dev server
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Create Flask app for web pages
flask_app = Flask(
    __name__,
    template_folder=str(Path(__file__).parent / 'templates'),
    static_folder=str(Path(__file__).parent / 'static')
)
flask_app.secret_key = settings.secret_key if hasattr(settings, 'secret_key') else os.urandom(24)

# Configure Flask to know it's mounted under /web
flask_app.config['APPLICATION_ROOT'] = '/web'
flask_app.config['PREFERRED_URL_SCHEME'] = 'http'

flask_app.register_blueprint(flask_web_blueprint)
flask_app.register_blueprint(flask_simple_blueprint, url_prefix='/simple')

# Debug: Add a test route directly to Flask app
@flask_app.route('/debug')
def debug_route():
    return f"Flask app working! Routes: {[rule.rule for rule in flask_app.url_map.iter_rules()]}"

print(f"Registered blueprints. Simple routes: {[rule.rule for rule in flask_app.url_map.iter_rules() if 'simple' in rule.rule]}")

# Pass flash messages to templates
@flask_app.context_processor
def inject_flash_messages():
    from flask import get_flashed_messages
    messages = get_flashed_messages(with_categories=True)
    return dict(flash_messages=messages)

# Mount Flask app to FastAPI for web routes only
app.mount("/web", WSGIMiddleware(flask_app))

# Include API routers
app.include_router(health.router)
app.include_router(pdf.router, prefix="/api")
app.include_router(youtube.router, prefix="/api")
app.include_router(audio.router, prefix="/api")
app.include_router(queue.router, prefix="/api")
app.include_router(stripe_payment.router, prefix="/api")


@app.get("/")
async def root():
    """Redirect to web interface"""
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url="/web/")


@app.get("/simple/")
async def simple_interface():
    """Simple Chatterbox TTS interface"""
    from fastapi.responses import HTMLResponse
    from pathlib import Path
    
    template_path = Path(__file__).parent / 'templates' / 'simple.html'
    if template_path.exists():
        with open(template_path, 'r') as f:
            return HTMLResponse(content=f.read())
    else:
        return HTMLResponse(content="""
        <html>
        <head><title>Echomancer Simple</title></head>
        <body>
        <h1>Echomancer Simple Interface</h1>
        <p>Template not found. Using basic interface.</p>
        <form action="/simple/generate" method="post" enctype="multipart/form-data">
            <div>
                <label>PDF File:</label>
                <input type="file" name="pdf" required>
            </div>
            <div>
                <label>Voice Sample:</label>
                <input type="file" name="voice_sample" required>
            </div>
            <div>
                <label>Reference Text (optional):</label>
                <input type="text" name="ref_text">
            </div>
            <button type="submit">Generate Audiobook</button>
        </form>
        </body>
        </html>
        """)


@app.post("/simple/generate")
async def simple_generate(pdf: UploadFile = File(...), voice_sample: UploadFile = File(...), ref_text: str = Form("")):
    """Generate audiobook using Chatterbox TTS"""
    from fastapi.responses import JSONResponse
    import tempfile
    import uuid
    
    # Create temp directory
    job_id = str(uuid.uuid4())[:8]
    job_dir = Path(tempfile.gettempdir()) / 'echomancer' / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    
    try:
        # Save uploaded files
        pdf_path = job_dir / f"input.pdf"
        voice_path = job_dir / f"voice.mp3"
        
        with open(pdf_path, 'wb') as f:
            f.write(await pdf.read())
        
        with open(voice_path, 'wb') as f:
            f.write(await voice_sample.read())
        
        # Generate audiobook using Chatterbox
        from app.services.tts import get_tts_provider
        from app.services import pdf as pdf_service
        
        # Extract text from PDF
        text = pdf_service.extract_text_from_pdf(str(pdf_path))
        
        # Get Chatterbox provider
        tts_provider = get_tts_provider("chatterbox")
        
        # Generate audio
        audio_file = await tts_provider.generate_audio(
            text=text[:1000],  # Limit text for demo
            voice_sample_url=f"file://{voice_path}",
            output_dir=str(job_dir),
            ref_text=ref_text
        )
        
        return JSONResponse({
            "status": "success",
            "job_id": job_id,
            "audio_url": f"/simple/audio/{job_id}"
        })
        
    except Exception as e:
        return JSONResponse({"status": "error", "message": str(e)}, status_code=500)


# Run with: uvicorn app.main:app --reload --port 8000
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=settings.port,
        reload=settings.environment == "development",
    )
