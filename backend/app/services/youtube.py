import subprocess
import httpx
from pathlib import Path
from typing import Optional, List, Dict, Any
import json
import tempfile
import uuid


async def search_videos(query: str, api_key: str, max_results: int = 10) -> List[Dict[str, Any]]:
    """Search YouTube for videos using the Data API v3."""
    url = "https://www.googleapis.com/youtube/v3/search"
    params = {
        "part": "snippet",
        "q": query,
        "type": "video",
        "maxResults": max_results,
        "key": api_key,
    }

    async with httpx.AsyncClient() as client:
        response = await client.get(url, params=params)
        response.raise_for_status()
        data = response.json()

    videos = []
    video_ids = [item["id"]["videoId"] for item in data.get("items", [])]

    if video_ids:
        # Get video details including duration
        details = await get_video_details(video_ids, api_key)
        details_map = {v["id"]: v for v in details}

        for item in data.get("items", []):
            video_id = item["id"]["videoId"]
            snippet = item["snippet"]
            detail = details_map.get(video_id, {})

            videos.append({
                "id": video_id,
                "title": snippet.get("title", ""),
                "description": snippet.get("description", ""),
                "thumbnail": snippet.get("thumbnails", {}).get("medium", {}).get("url", ""),
                "channelTitle": snippet.get("channelTitle", ""),
                "duration": detail.get("duration", ""),
                "durationSeconds": parse_duration(detail.get("duration", "")),
            })

    return videos


async def get_video_details(video_ids: List[str], api_key: str) -> List[Dict[str, Any]]:
    """Get video details including duration."""
    url = "https://www.googleapis.com/youtube/v3/videos"
    params = {
        "part": "contentDetails,snippet",
        "id": ",".join(video_ids),
        "key": api_key,
    }

    async with httpx.AsyncClient() as client:
        response = await client.get(url, params=params)
        response.raise_for_status()
        data = response.json()

    return [
        {
            "id": item["id"],
            "duration": item.get("contentDetails", {}).get("duration", ""),
            "title": item.get("snippet", {}).get("title", ""),
        }
        for item in data.get("items", [])
    ]


def parse_duration(iso_duration: str) -> int:
    """Parse ISO 8601 duration to seconds (e.g., PT4M13S -> 253)."""
    if not iso_duration:
        return 0

    import re
    pattern = r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?"
    match = re.match(pattern, iso_duration)

    if not match:
        return 0

    hours = int(match.group(1) or 0)
    minutes = int(match.group(2) or 0)
    seconds = int(match.group(3) or 0)

    return hours * 3600 + minutes * 60 + seconds


def download_audio(video_id: str, output_dir: str, start_time: float = 0, end_time: float = 60) -> Path:
    """
    Download audio from YouTube video and optionally clip it.
    Uses yt-dlp for reliable downloading.
    """
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    temp_file = output_path / f"{uuid.uuid4()}_full.mp3"
    final_file = output_path / f"{uuid.uuid4()}_clip.mp3"

    # Download audio using yt-dlp
    url = f"https://www.youtube.com/watch?v={video_id}"

    download_cmd = [
        "yt-dlp",
        "-x",  # Extract audio
        "--audio-format", "mp3",
        "--audio-quality", "192K",
        "-o", str(temp_file),
        url,
    ]

    subprocess.run(download_cmd, check=True, capture_output=True)

    # Clip the audio to specified time range using ffmpeg
    clip_cmd = [
        "ffmpeg",
        "-i", str(temp_file),
        "-ss", str(start_time),
        "-t", str(end_time - start_time),
        "-acodec", "libmp3lame",
        "-y",  # Overwrite output
        str(final_file),
    ]

    subprocess.run(clip_cmd, check=True, capture_output=True)

    # Clean up full file
    temp_file.unlink(missing_ok=True)

    return final_file


async def download_audio_async(
    video_id: str,
    output_dir: str,
    start_time: float = 0,
    end_time: float = 60
) -> Path:
    """Async wrapper for download_audio."""
    import asyncio
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None,
        download_audio,
        video_id,
        output_dir,
        start_time,
        end_time
    )
