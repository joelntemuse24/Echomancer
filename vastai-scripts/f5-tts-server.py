#!/usr/bin/env python3
"""
F5-TTS API Server for Vast.ai

This server wraps F5-TTS to provide a simple HTTP API for voice cloning.
Run this on your Vast.ai GPU instance to generate audiobook audio.

Setup:
    pip install f5-tts fastapi uvicorn httpx

Usage:
    python f5-tts-server.py

The server will run on port 8080 by default.
"""

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
import tempfile
import httpx
import uuid
import subprocess
import os
from pathlib import Path

app = FastAPI(title="F5-TTS API Server")

# Configuration
MODEL = os.environ.get("F5_MODEL", "F5TTS_v1_Base")
TEMP_DIR = Path(tempfile.gettempdir()) / "f5-tts-api"
TEMP_DIR.mkdir(exist_ok=True)


class GenerateRequest(BaseModel):
    text: str
    voice_sample_url: str
    ref_text: str = ""  # Optional transcription of reference audio


class HealthResponse(BaseModel):
    status: str
    model: str


@app.get("/health", response_model=HealthResponse)
async def health():
    """Health check endpoint."""
    return HealthResponse(status="ok", model=MODEL)


@app.post("/generate")
async def generate_audio(request: GenerateRequest):
    """
    Generate speech audio from text using F5-TTS voice cloning.

    Args:
        text: The text to synthesize
        voice_sample_url: URL to a 10-30 second reference audio clip
        ref_text: Optional transcription of the reference audio

    Returns:
        WAV audio file
    """
    job_id = str(uuid.uuid4())
    job_dir = TEMP_DIR / job_id
    job_dir.mkdir(exist_ok=True)

    try:
        # Download the voice sample
        voice_path = job_dir / "reference.wav"
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.get(request.voice_sample_url)
            response.raise_for_status()
            voice_path.write_bytes(response.content)

        # Build F5-TTS command
        cmd = [
            "f5-tts_infer-cli",
            "--model", MODEL,
            "--ref_audio", str(voice_path),
            "--gen_text", request.text,
            "--output_dir", str(job_dir),
        ]

        if request.ref_text:
            cmd.extend(["--ref_text", request.ref_text])

        # Run F5-TTS
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300,  # 5 minute timeout
        )

        if result.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"F5-TTS error: {result.stderr}"
            )

        # Find the generated audio file
        wav_files = list(job_dir.glob("*.wav"))
        # Filter out the reference file
        output_files = [f for f in wav_files if f.name != "reference.wav"]

        if not output_files:
            raise HTTPException(
                status_code=500,
                detail="F5-TTS did not generate any output"
            )

        # Return the most recent output file
        output_file = max(output_files, key=lambda f: f.stat().st_mtime)

        return FileResponse(
            output_file,
            media_type="audio/wav",
            filename=f"{job_id}.wav"
        )

    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to download voice sample: {str(e)}"
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(
            status_code=504,
            detail="Generation timed out (>5 minutes)"
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Generation failed: {str(e)}"
        )


@app.post("/generate-batch")
async def generate_batch(requests: list[GenerateRequest]):
    """
    Generate multiple audio segments in sequence.
    Useful for generating chapters or paragraphs.

    Returns a list of download URLs for the generated audio files.
    """
    results = []
    for i, req in enumerate(requests):
        try:
            # Reuse the single generate logic
            job_id = str(uuid.uuid4())
            job_dir = TEMP_DIR / job_id
            job_dir.mkdir(exist_ok=True)

            # Download voice sample
            voice_path = job_dir / "reference.wav"
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.get(req.voice_sample_url)
                response.raise_for_status()
                voice_path.write_bytes(response.content)

            # Run F5-TTS
            cmd = [
                "f5-tts_infer-cli",
                "--model", MODEL,
                "--ref_audio", str(voice_path),
                "--gen_text", req.text,
                "--output_dir", str(job_dir),
            ]
            if req.ref_text:
                cmd.extend(["--ref_text", req.ref_text])

            result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

            if result.returncode != 0:
                results.append({"index": i, "success": False, "error": result.stderr})
                continue

            wav_files = [f for f in job_dir.glob("*.wav") if f.name != "reference.wav"]
            if wav_files:
                output_file = max(wav_files, key=lambda f: f.stat().st_mtime)
                results.append({
                    "index": i,
                    "success": True,
                    "file": str(output_file),
                    "job_id": job_id
                })
            else:
                results.append({"index": i, "success": False, "error": "No output generated"})

        except Exception as e:
            results.append({"index": i, "success": False, "error": str(e)})

    return {"results": results}


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 8080))
    print(f"Starting F5-TTS API Server on port {port}")
    print(f"Using model: {MODEL}")
    print(f"Temp directory: {TEMP_DIR}")

    uvicorn.run(app, host="0.0.0.0", port=port)
