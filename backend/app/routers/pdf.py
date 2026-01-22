from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
import uuid

from ..config import get_settings, Settings
from ..services import pdf as pdf_service
from ..services.bunny import get_bunny_client

router = APIRouter(prefix="/pdf", tags=["PDF"])


class PDFUploadResponse(BaseModel):
    success: bool
    pdf_url: str
    filename: str
    text_preview: Optional[str] = None


@router.post("/upload", response_model=PDFUploadResponse)
async def upload_pdf(
    file: UploadFile = File(...),
    settings: Settings = Depends(get_settings)
):
    """
    Upload a PDF file for processing.

    Supported formats: PDF
    Max size: 100MB
    """
    try:
        # Validate file type
        if not file.filename.lower().endswith('.pdf'):
            raise HTTPException(
                status_code=400,
                detail="Only PDF files are supported"
            )

        # Check file size (100MB limit)
        contents = await file.read()
        if len(contents) > 100 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="File too large (max 100MB)")

        # Extract text preview
        try:
            full_text = pdf_service.extract_text_from_bytes(contents)
            text_preview = full_text[:500] + "..." if len(full_text) > 500 else full_text
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Could not read PDF: {str(e)}")

        # Upload to CDN
        bunny_client = get_bunny_client(
            settings.bunny_storage_zone,
            settings.bunny_api_key,
            settings.bunny_cdn_url,
        )

        file_id = str(uuid.uuid4())
        remote_path = f"pdfs/{file_id}.pdf"

        if bunny_client:
            try:
                pdf_url = await bunny_client.upload_bytes(contents, remote_path)
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")
        else:
            # Local dev fallback - save to temp dir
            from pathlib import Path
            local_path = Path(settings.temp_dir) / "pdfs" / f"{file_id}.pdf"
            local_path.parent.mkdir(parents=True, exist_ok=True)
            local_path.write_bytes(contents)
            # Convert Windows path to file:// URL with forward slashes
            pdf_url = f"file:///{local_path.as_posix()}"

        return PDFUploadResponse(
            success=True,
            pdf_url=pdf_url,
            filename=file.filename,
            text_preview=text_preview,
        )
    except Exception as e:
        # Log the full error for debugging
        import traceback
        print(f"PDF upload error: {e}")
        print(f"Traceback: {traceback.format_exc()}")
        raise


@router.get("/text")
async def get_pdf_text(pdf_url: str):
    """Extract full text from a PDF URL."""
    try:
        text = await pdf_service.extract_text_from_url(pdf_url)
        return {"text": text, "length": len(text)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not extract text: {str(e)}")
