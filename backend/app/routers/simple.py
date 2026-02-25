"""
Simple Audiobook Generator - FastAPI Router
F5-TTS voice cloning via Replicate API.
"""

from fastapi import APIRouter, UploadFile, File, Form, Request
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.templating import Jinja2Templates
from pathlib import Path
import uuid
import tempfile
import logging
import os

from ..config import get_settings
from ..services import pdf as pdf_service
from ..services.tts import get_tts_provider

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/simple", tags=["Simple"])

templates = Jinja2Templates(directory=str(Path(__file__).parent.parent / "templates"))


@router.get("/", response_class=HTMLResponse)
async def index(request: Request):
    """Simple one-page audiobook generator"""
    return templates.TemplateResponse("simple.html", {
        "request": request,
        "flash_messages": [],
    })


@router.post("/generate")
async def generate(
    request: Request,
    pdf: UploadFile = File(...),
    voice_sample: UploadFile = File(None),
    ref_text: str = Form(""),
):
    """Generate audiobook using CosyVoice."""
    job_id = str(uuid.uuid4())[:8]
    job_dir = Path(tempfile.gettempdir()) / "echomancer" / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    try:
        # 1. Save uploaded PDF
        pdf_path = job_dir / "input.pdf"
        with open(pdf_path, "wb") as f:
            f.write(await pdf.read())

        # 2. Save voice sample if provided
        voice_path = None
        if voice_sample and voice_sample.filename:
            suffix = Path(voice_sample.filename).suffix or ".wav"
            voice_path = job_dir / f"voice_sample{suffix}"
            with open(voice_path, "wb") as f:
                f.write(await voice_sample.read())

        # 3. Extract text from PDF
        text = pdf_service.extract_text_from_file(pdf_path)
        if not text.strip():
            return JSONResponse(
                {"status": "error", "message": "Could not extract text from PDF. Is it a scanned document?"},
                status_code=400,
            )

        # 4. Generate audio with Cartesia
        logger.info(f"[TTS] Processing {len(text)} chars, job={job_id}")

        tts_provider = get_tts_provider()

        voice_url = f"file://{voice_path}" if voice_path else ""
        output_path = tts_provider.generate_audio(
            text=text,
            voice_sample_url=voice_url,
            output_dir=str(job_dir),
            ref_text=ref_text,
        )

        if not output_path or not Path(output_path).exists():
            return JSONResponse(
                {"status": "error", "message": "Audio generation failed - no output file created"},
                status_code=500,
            )

        logger.info(f"[TTS] Audio generated: {output_path}")

        return JSONResponse({
            "status": "success",
            "job_id": job_id,
            "audio_url": f"/simple/audio/{job_id}",
            "message": "Audiobook generated successfully!",
        })

    except Exception as e:
        logger.error(f"[TTS] Generation failed: {e}", exc_info=True)
        return JSONResponse(
            {"status": "error", "message": str(e)},
            status_code=500,
        )


@router.get("/audio/{job_id}")
async def serve_audio(job_id: str):
    """Serve generated audio file for download."""
    audio_dir = Path(tempfile.gettempdir()) / "echomancer" / job_id
    if not audio_dir.exists():
        return JSONResponse({"error": "Audio not found"}, status_code=404)

    # Find the .wav file in the job directory
    wav_files = list(audio_dir.glob("*.wav"))
    if not wav_files:
        return JSONResponse({"error": "Audio file not found"}, status_code=404)

    return FileResponse(
        path=str(wav_files[0]),
        media_type="audio/wav",
        filename=f"audiobook_{job_id}.wav",
    )


@router.get("/test")
async def test_tts():
    """Test if F5-TTS Replicate is configured and working."""
    result = {
        "tts_provider": "f5tts-replicate",
        "api_token_configured": False,
        "model": settings.f5tts_model,
    }
    
    # Check API token
    if settings.replicate_api_token and settings.replicate_api_token != "your_replicate_token_here":
        result["api_token_configured"] = True
    else:
        result["api_token_configured"] = False
        result["message"] = "Replicate API token not configured. Get token at https://replicate.com/account/api-tokens"
    
    return result
