"""Test Replicate API integration"""
import asyncio
from pathlib import Path

async def test_replicate():
    """Test the complete TTS flow with Replicate"""
    from app.services import tts
    from app.config import get_settings

    settings = get_settings()

    print(f"Testing Replicate TTS Provider...")
    print(f"API Token: {settings.replicate_api_token[:20]}...")
    print()

    # Use the actual uploaded files
    pdf_text = "This is a test of the audiobook generation system."
    voice_url = "file:///C:/temp/echomancer/samples/e91088b5-f630-406e-a5b5-8d39e702196b.mp3"
    output_dir = "C:/temp/echomancer/test_output"

    try:
        print("Generating audiobook with Replicate...")
        result = await tts.generate_audiobook(
            text=pdf_text,
            voice_sample_url=voice_url,
            output_dir=output_dir,
            provider_type="replicate",
            replicate_token=settings.replicate_api_token,
        )
        print(f"[OK] Audiobook generated successfully!")
        print(f"Output file: {result}")
        print(f"File exists: {result.exists()}")
        print(f"File size: {result.stat().st_size} bytes")
    except Exception as e:
        print(f"[FAIL] Audiobook generation failed: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(test_replicate())
