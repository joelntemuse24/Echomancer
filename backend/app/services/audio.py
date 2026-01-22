import subprocess
from pathlib import Path
from typing import List, Optional
import uuid
import asyncio


async def clip_audio(
    input_path: Path,
    output_dir: str,
    start_time: float,
    end_time: float
) -> Path:
    """
    Clip audio file to specified time range.

    Args:
        input_path: Path to input audio file
        output_dir: Directory for output file
        start_time: Start time in seconds
        end_time: End time in seconds

    Returns:
        Path to clipped audio file
    """
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    output_file = output_path / f"{uuid.uuid4()}_clip.mp3"

    cmd = [
        "ffmpeg",
        "-i", str(input_path),
        "-ss", str(start_time),
        "-t", str(end_time - start_time),
        "-acodec", "libmp3lame",
        "-y",
        str(output_file),
    ]

    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None,
        lambda: subprocess.run(cmd, check=True, capture_output=True)
    )

    return output_file


async def concatenate_audio_files(input_files: List[Path], output_file: Path) -> Path:
    """
    Concatenate multiple audio files into one.

    Args:
        input_files: List of paths to audio files
        output_file: Path for output file

    Returns:
        Path to concatenated audio file
    """
    if len(input_files) == 1:
        # Just copy if only one file
        import shutil
        shutil.copy(input_files[0], output_file)
        return output_file

    # Create concat file list for ffmpeg
    concat_list = output_file.parent / f"{uuid.uuid4()}_concat.txt"
    with open(concat_list, "w") as f:
        for audio_file in input_files:
            f.write(f"file '{audio_file}'\n")

    cmd = [
        "ffmpeg",
        "-f", "concat",
        "-safe", "0",
        "-i", str(concat_list),
        "-acodec", "libmp3lame",
        "-y",
        str(output_file),
    ]

    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None,
        lambda: subprocess.run(cmd, check=True, capture_output=True)
    )

    # Clean up concat list
    concat_list.unlink(missing_ok=True)

    return output_file


async def add_watermark(
    audio_path: Path,
    watermark_path: Optional[Path],
    output_dir: str,
    position: str = "start"  # "start" or "end"
) -> Path:
    """
    Add watermark audio to the beginning or end of an audio file.

    Args:
        audio_path: Path to main audio file
        watermark_path: Path to watermark audio file
        output_dir: Directory for output file
        position: Where to add watermark ("start" or "end")

    Returns:
        Path to watermarked audio file
    """
    if watermark_path is None or not watermark_path.exists():
        # No watermark, return original
        return audio_path

    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    output_file = output_path / f"{uuid.uuid4()}_watermarked.mp3"

    if position == "start":
        files = [watermark_path, audio_path]
    else:
        files = [audio_path, watermark_path]

    await concatenate_audio_files(files, output_file)

    return output_file


async def add_intro_and_outro(
    audio_path: Path,
    intro_path: Optional[Path],
    outro_path: Optional[Path],
    output_dir: str
) -> Path:
    """
    Add intro and outro to an audio file.

    Args:
        audio_path: Path to main audio file
        intro_path: Path to intro audio (played at start)
        outro_path: Path to outro audio (played at end)
        output_dir: Directory for output file

    Returns:
        Path to final audio file
    """
    files = []

    if intro_path and intro_path.exists():
        files.append(intro_path)

    files.append(audio_path)

    if outro_path and outro_path.exists():
        files.append(outro_path)

    if len(files) == 1:
        return audio_path

    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    output_file = output_path / f"{uuid.uuid4()}_final.mp3"

    await concatenate_audio_files(files, output_file)

    return output_file


async def get_audio_duration(audio_path: Path) -> float:
    """Get duration of audio file in seconds."""
    cmd = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(audio_path),
    ]

    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None,
        lambda: subprocess.run(cmd, check=True, capture_output=True, text=True)
    )

    return float(result.stdout.strip())


async def convert_to_mp3(input_path: Path, output_dir: str, bitrate: str = "192k") -> Path:
    """Convert audio file to MP3 format."""
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    output_file = output_path / f"{uuid.uuid4()}.mp3"

    cmd = [
        "ffmpeg",
        "-i", str(input_path),
        "-acodec", "libmp3lame",
        "-b:a", bitrate,
        "-y",
        str(output_file),
    ]

    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None,
        lambda: subprocess.run(cmd, check=True, capture_output=True)
    )

    return output_file
