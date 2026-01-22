#!/usr/bin/env python3
"""
Fish Speech API Server for Vast.ai

Run this on your Vast.ai instance to expose Fish Speech as an HTTP API
that your Echomancer backend can call.

Usage:
    python fish-speech-server.py

The server will run on port 8000 and accept POST requests to /generate
"""

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
import subprocess
import tempfile
import httpx
import uuid
import os
from pathlib import Path

app = FastAPI(title="Fish Speech API Server")

# Configuration
FISH_SPEECH_DIR = os.getenv("FISH_SPEECH_DIR", "/workspace/fish-speech")
CHECKPOINT_PATH = os.getenv("CHECKPOINT_PATH", "checkpoints/fish-speech-1.5")
TEMP_DIR = Path(tempfile.gettempdir()) / "fish-speech-api"
TEMP_DIR.mkdir(exist_ok=True)


class GenerateRequest(BaseModel):
    text: str
    voice_sample_url: str


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "model": "fish-speech-1.5"}


@app.post("/generate")
async def generate_audio(request: GenerateRequest):
    """
    Generate audio from text using a voice sample.

    Args:
        text: The text to convert to speech
        voice_sample_url: URL to download the voice sample from

    Returns:
        Audio file (WAV format)
    """
    job_id = str(uuid.uuid4())
    job_dir = TEMP_DIR / job_id
    job_dir.mkdir(exist_ok=True)

    try:
        # Download voice sample
        voice_path = job_dir / "voice_sample.wav"
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.get(request.voice_sample_url)
            response.raise_for_status()
            voice_path.write_bytes(response.content)

        # Output path
        output_path = job_dir / "output.wav"

        # Run Fish Speech inference
        cmd = [
            "python", "-m", "tools.infer",
            "--text", request.text,
            "--reference-audio", str(voice_path),
            "--output", str(output_path),
            "--checkpoint", CHECKPOINT_PATH,
        ]

        result = subprocess.run(
            cmd,
            cwd=FISH_SPEECH_DIR,
            capture_output=True,
            text=True,
            timeout=300,  # 5 minute timeout per chunk
        )

        if result.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"Fish Speech error: {result.stderr}"
            )

        if not output_path.exists():
            raise HTTPException(
                status_code=500,
                detail="Output file was not generated"
            )

        # Return the audio file
        return FileResponse(
            output_path,
            media_type="audio/wav",
            filename=f"{job_id}.wav",
            background=None,  # Don't delete immediately
        )

    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to download voice sample: {str(e)}"
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(
            status_code=504,
            detail="Generation timed out"
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Generation failed: {str(e)}"
        )
    finally:
        # Cleanup (with small delay to allow file to be sent)
        import asyncio
        asyncio.create_task(cleanup_job_dir(job_dir))


async def cleanup_job_dir(job_dir: Path):
    """Clean up job directory after a delay."""
    import asyncio
    await asyncio.sleep(60)  # Wait 1 minute before cleanup
    import shutil
    shutil.rmtree(job_dir, ignore_errors=True)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
