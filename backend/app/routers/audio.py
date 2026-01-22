from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
import uuid

from ..config import get_settings, Settings
from ..services.bunny import get_bunny_client

router = APIRouter(prefix="/audio", tags=["Audio"])


class AudioUploadResponse(BaseModel):
    success: bool
    audio_url: str
    filename: str


@router.post("/upload-sample", response_model=AudioUploadResponse)
async def upload_audio_sample(
    file: UploadFile = File(...),
    settings: Settings = Depends(get_settings)
):
    """
    Upload an audio file to use as a voice sample.

    Supported formats: MP3, WAV, M4A, OGG
    Max size: 50MB
    """
    try:
        # Validate file type
        allowed_extensions = {".mp3", ".wav", ".m4a", ".ogg"}
        file_ext = "." + file.filename.lower().split(".")[-1] if "." in file.filename else ""

        if file_ext not in allowed_extensions:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported audio format. Allowed: {', '.join(allowed_extensions)}"
            )

        # Check file size (50MB limit)
        contents = await file.read()
        if len(contents) > 50 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="File too large (max 50MB)")

        # Upload to CDN
        bunny_client = get_bunny_client(
            settings.bunny_storage_zone,
            settings.bunny_api_key,
            settings.bunny_cdn_url,
        )

        file_id = str(uuid.uuid4())
        remote_path = f"samples/{file_id}{file_ext}"

        if bunny_client:
            try:
                audio_url = await bunny_client.upload_bytes(contents, remote_path)
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")
        else:
            # Local dev fallback
            from pathlib import Path
            local_path = Path(settings.temp_dir) / "samples" / f"{file_id}{file_ext}"
            local_path.parent.mkdir(parents=True, exist_ok=True)
            local_path.write_bytes(contents)
            # Convert Windows path to file:// URL with forward slashes
            audio_url = f"file:///{local_path.as_posix()}"

        return AudioUploadResponse(
            success=True,
            audio_url=audio_url,
            filename=file.filename,
        )
    except Exception as e:
        # Log the full error for debugging
        import traceback
        print(f"Audio upload error: {e}")
        print(f"Traceback: {traceback.format_exc()}")
        raise
