import httpx
import pdfplumber
from io import BytesIO
from pathlib import Path
from typing import Optional
import tempfile


async def extract_text_from_url(pdf_url: str) -> str:
    """Download PDF from URL and extract text."""
    if pdf_url.startswith("file://"):
        # Local file - read directly
        # Handle file:// URLs properly for Windows
        file_path = pdf_url.replace("file:///", "").replace("file://", "")
        local_path = Path(file_path)
        return extract_text_from_file(local_path)
    else:
        # Remote file - download via HTTP
        async with httpx.AsyncClient() as client:
            response = await client.get(pdf_url, timeout=60.0)
            response.raise_for_status()
            return extract_text_from_bytes(response.content)


def extract_text_from_bytes(pdf_bytes: bytes) -> str:
    """Extract text from PDF bytes."""
    text_parts = []

    with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text()
            if page_text:
                text_parts.append(page_text)

    return "\n\n".join(text_parts)


def extract_text_from_file(file_path: Path) -> str:
    """Extract text from a local PDF file."""
    text_parts = []

    with pdfplumber.open(file_path) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text()
            if page_text:
                text_parts.append(page_text)

    return "\n\n".join(text_parts)


async def save_uploaded_pdf(content: bytes, filename: str, temp_dir: str) -> Path:
    """Save uploaded PDF to temp directory and return path."""
    temp_path = Path(temp_dir)
    temp_path.mkdir(parents=True, exist_ok=True)

    file_path = temp_path / filename
    file_path.write_bytes(content)

    return file_path
