"""
Echomancer Backend - FastAPI + Flask Application

PDF to Audiobook converter using Fish Speech voice cloning.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.wsgi import WSGIMiddleware
from flask import Flask
from pathlib import Path
import os

from .config import get_settings
from .routers import pdf, youtube, audio, queue, payment, health
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
print(f"Registered blueprints. Simple routes: {[rule.rule for rule in flask_app.url_map.iter_rules() if 'simple' in rule.rule]}")

# Pass flash messages to templates
@flask_app.context_processor
def inject_flash_messages():
    from flask import get_flashed_messages
    messages = get_flashed_messages(with_categories=True)
    return dict(flash_messages=messages)

# Mount Flask app to FastAPI for web routes
app.mount("/web", WSGIMiddleware(flask_app))

# Include API routers
app.include_router(health.router)
app.include_router(pdf.router, prefix="/api")
app.include_router(youtube.router, prefix="/api")
app.include_router(audio.router, prefix="/api")
app.include_router(queue.router, prefix="/api")
app.include_router(payment.router, prefix="/api")


@app.get("/")
async def root():
    """Redirect to web interface"""
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url="/web/")


# Run with: uvicorn app.main:app --reload --port 8000
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=settings.port,
        reload=settings.environment == "development",
    )
