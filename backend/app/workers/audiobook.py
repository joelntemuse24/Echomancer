"""
Background worker for processing audiobook generation jobs.
Uses ARQ (Async Redis Queue) for job management.
"""

import asyncio
from pathlib import Path
from typing import Optional
from arq import create_pool
from arq.connections import RedisSettings, ArqRedis
import redis.asyncio as redis

from ..config import get_settings
from ..services import pdf, youtube, tts, audio, bunny


async def process_audiobook_job(
    ctx: dict,
    job_id: str,
    user_id: str,
    pdf_url: str,
    video_id: Optional[str] = None,
    audio_sample_url: Optional[str] = None,
    start_time: float = 0.0,
    end_time: float = 60.0,
) -> dict:
    """
    Main job processor for audiobook generation.

    Pipeline:
    1. Extract text from PDF
    2. Get voice sample (from YouTube or uploaded file)
    3. Generate audio using Fish Speech
    4. Add watermark/intro/outro
    5. Upload to CDN
    6. Return final URL

    Args:
        ctx: ARQ context (contains redis connection)
        job_id: Unique job identifier
        user_id: User who requested the job
        pdf_url: URL to the PDF file
        video_id: YouTube video ID for voice sample (optional)
        audio_sample_url: URL to uploaded voice sample (optional)
        start_time: Start time for voice clip (seconds)
        end_time: End time for voice clip (seconds)

    Returns:
        Dict with status and audio_url
    """
    settings = get_settings()
    redis_client: ArqRedis = ctx["redis"]

    # Helper to update job status
    async def update_status(status: str, progress: int, error: str = None):
        await redis_client.set(f"job:{job_id}:status", status)
        await redis_client.set(f"job:{job_id}:progress", str(progress))
        if error:
            await redis_client.set(f"job:{job_id}:error", error)

    try:
        await update_status("processing", 5)

        # Create temp directory for this job
        temp_dir = Path(settings.temp_dir) / job_id
        temp_dir.mkdir(parents=True, exist_ok=True)

        # Step 1: Extract text from PDF
        await update_status("processing", 10)
        pdf_text = await pdf.extract_text_from_url(pdf_url)

        if not pdf_text.strip():
            raise ValueError("Could not extract text from PDF")

        await update_status("processing", 25)

        # Step 2: Get voice sample
        voice_sample_path: Path = None

        if audio_sample_url:
            # Download uploaded sample
            if audio_sample_url.startswith("file://"):
                # Local file - copy directly
                voice_sample_path = temp_dir / "voice_sample.mp3"
                # Handle file:// URLs properly for Windows
                file_path = audio_sample_url.replace("file:///", "").replace("file://", "")
                source_path = Path(file_path)
                voice_sample_path.write_bytes(source_path.read_bytes())
            else:
                # Remote file - download via HTTP
                import httpx
                async with httpx.AsyncClient() as client:
                    response = await client.get(audio_sample_url, timeout=60.0)
                    response.raise_for_status()
                    voice_sample_path = temp_dir / "voice_sample.mp3"
                    voice_sample_path.write_bytes(response.content)
        elif video_id:
            # Download from YouTube
            voice_sample_path = await youtube.download_audio_async(
                video_id=video_id,
                output_dir=str(temp_dir),
                start_time=start_time,
                end_time=end_time,
            )
        else:
            raise ValueError("Either video_id or audio_sample_url must be provided")

        await update_status("processing", 40)

        # Step 3: Upload voice sample to CDN (or use local file for dev)
        bunny_client = bunny.get_bunny_client(
            settings.bunny_storage_zone,
            settings.bunny_api_key,
            settings.bunny_cdn_url,
        )

        if bunny_client:
            voice_sample_url = await bunny_client.upload_file(
                voice_sample_path,
                f"samples/{user_id}/{job_id}_voice.mp3"
            )
        else:
            # For local dev without Bunny, use file:// URL
            # The Replicate provider will handle converting this to base64
            voice_sample_url = f"file://{voice_sample_path.absolute()}"

        await update_status("processing", 50)

        # Step 4: Generate audiobook with Fish Speech
        # Supports both Replicate (~$2/10hr) and Vast.ai (~$0.50/10hr)
        audiobook_path = await tts.generate_audiobook(
            text=pdf_text,
            voice_sample_url=voice_sample_url,
            output_dir=str(temp_dir),
            provider_type=settings.tts_provider,
            replicate_token=settings.replicate_api_token,
            vastai_url=settings.vastai_url,
            vastai_key=settings.vastai_api_key,
        )

        await update_status("processing", 80)

        # Step 5: Add intro/outro (optional - paths would come from settings)
        # For now, skip watermarking
        final_audio_path = audiobook_path

        await update_status("processing", 90)

        # Step 6: Upload final audio to CDN (or use local file for dev)
        if bunny_client:
            final_url = await bunny_client.upload_file(
                final_audio_path,
                f"audiobooks/{user_id}/{job_id}.mp3"
            )
        else:
            # For local dev, save to a local directory and provide file:// URL
            # Note: This won't be downloadable from the web UI, but works for testing
            final_url = f"file://{final_audio_path.absolute()}"

        # Store result
        await redis_client.set(f"job:{job_id}:audio_url", final_url)
        await update_status("completed", 100)

        # Cleanup temp files
        import shutil
        shutil.rmtree(temp_dir, ignore_errors=True)

        return {"status": "completed", "audio_url": final_url}

    except Exception as e:
        await update_status("failed", 0, str(e))
        return {"status": "failed", "error": str(e)}


async def startup(ctx: dict):
    """Called when worker starts."""
    settings = get_settings()
    print(f"Worker starting, connecting to Redis at {settings.redis_host}:{settings.redis_port}")


async def shutdown(ctx: dict):
    """Called when worker shuts down."""
    print("Worker shutting down")


class WorkerSettings:
    """ARQ worker settings."""

    functions = [process_audiobook_job]
    on_startup = startup
    on_shutdown = shutdown

    # Redis settings - must be RedisSettings, not a function
    redis_settings = RedisSettings(
        host=get_settings().redis_host,
        port=get_settings().redis_port,
        password=get_settings().redis_password or None,
    )


# For running the worker directly
if __name__ == "__main__":
    import arq.cli
    arq.cli.main()
