"""Test worker code to find issues before running"""
import asyncio
from pathlib import Path

async def test_file_paths():
    """Test the file path conversion logic"""

    # Test PDF path
    pdf_url = "file:///C:/temp/echomancer/pdfs/e265fdd9-832b-4d9c-97e5-69f44f747ffb_echo_test_1.pdf"
    file_path = pdf_url.replace("file:///", "").replace("file://", "")
    pdf_path = Path(file_path)
    print(f"PDF URL: {pdf_url}")
    print(f"Converted path: {file_path}")
    print(f"Path object: {pdf_path}")
    print(f"Exists: {pdf_path.exists()}")
    print()

    # Test audio path
    audio_url = "file:///C:/temp/echomancer/samples/e91088b5-f630-406e-a5b5-8d39e702196b.mp3"
    audio_file_path = audio_url.replace("file:///", "").replace("file://", "")
    audio_path = Path(audio_file_path)
    print(f"Audio URL: {audio_url}")
    print(f"Converted path: {audio_file_path}")
    print(f"Path object: {audio_path}")
    print(f"Exists: {audio_path.exists()}")
    print()

    # Test PDF extraction
    print("Testing PDF extraction...")
    try:
        from app.services import pdf
        text = await pdf.extract_text_from_url(pdf_url)
        print(f"[OK] PDF extraction worked! Extracted {len(text)} characters")
        print(f"First 100 chars: {text[:100]}")
    except Exception as e:
        print(f"[FAIL] PDF extraction FAILED: {e}")
    print()

    # Test audio file reading
    print("Testing audio file reading...")
    try:
        audio_bytes = audio_path.read_bytes()
        print(f"[OK] Audio file read worked! File size: {len(audio_bytes)} bytes")
    except Exception as e:
        print(f"[FAIL] Audio file read FAILED: {e}")
    print()

    # Test Replicate API token
    print("Testing Replicate configuration...")
    from app.config import get_settings
    settings = get_settings()
    print(f"TTS Provider: {settings.tts_provider}")
    print(f"Replicate token: {settings.replicate_api_token[:20]}...")
    print()

if __name__ == "__main__":
    asyncio.run(test_file_paths())
