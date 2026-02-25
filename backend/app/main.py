"""
Echomancer Backend - FastAPI Application

PDF to Audiobook converter using F5-TTS via Replicate API.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from pathlib import Path
import os

from .config import get_settings
from .routers import pdf, youtube, audio, health
from .routers import stripe_payment
from .routers import simple

# Create FastAPI app
app = FastAPI(
    title="Echomancer API",
    description="Transform PDFs into audiobooks with custom AI voices",
    version="0.3.0",
)

# Get settings
settings = get_settings()

# CORS - allow Render domain, localhost dev servers, and configured frontend
allowed_origins = [
    settings.frontend_url,
    "http://localhost:3000",
    "http://localhost:5173",
]
# Add Render external URL if available
render_url = os.getenv("RENDER_EXTERNAL_URL", "")
if render_url:
    allowed_origins.append(render_url)

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files
static_dir = Path(__file__).parent / "static"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

# Include API routers
app.include_router(health.router)
app.include_router(pdf.router, prefix="/api")
app.include_router(youtube.router, prefix="/api")
app.include_router(audio.router, prefix="/api")
app.include_router(stripe_payment.router, prefix="/api")
app.include_router(simple.router)


@app.get("/")
async def root():
    """Redirect to simple interface"""
    return RedirectResponse(url="/simple/")


# Run with: uvicorn app.main:app --host 0.0.0.0 --port $PORT
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=settings.port,
        reload=settings.environment == "development",
    )
