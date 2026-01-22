#!/usr/bin/env python3
"""
Fish Speech Audiobook Generator for Vast.ai
Usage: python generate-audiobook.py --text book.txt --voice voice_sample.wav --output audiobook.mp3
"""

import argparse
import os
import subprocess
from pathlib import Path
import re


def split_text_into_chunks(text: str, max_chars: int = 500) -> list[str]:
    """
    Split text into chunks at sentence boundaries.
    Fish Speech works best with chunks of 200-500 characters.
    """
    # Split on sentence endings
    sentences = re.split(r'(?<=[.!?])\s+', text)
    chunks = []
    current_chunk = ""

    for sentence in sentences:
        # If single sentence is too long, split it further
        if len(sentence) > max_chars:
            # Split on commas or just by length
            words = sentence.split()
            temp_chunk = ""
            for word in words:
                if len(temp_chunk) + len(word) + 1 <= max_chars:
                    temp_chunk += word + " "
                else:
                    if temp_chunk:
                        chunks.append(temp_chunk.strip())
                    temp_chunk = word + " "
            if temp_chunk:
                if current_chunk:
                    chunks.append(current_chunk.strip())
                    current_chunk = ""
                chunks.append(temp_chunk.strip())
            continue

        if len(current_chunk) + len(sentence) + 1 <= max_chars:
            current_chunk += sentence + " "
        else:
            if current_chunk:
                chunks.append(current_chunk.strip())
            current_chunk = sentence + " "

    if current_chunk:
        chunks.append(current_chunk.strip())

    return chunks


def generate_audio_chunk(
    text: str,
    voice_file: str,
    output_file: str,
    fish_speech_dir: str = "/workspace/fish-speech"
) -> bool:
    """Generate audio for a single chunk using Fish Speech CLI."""

    # Fish Speech inference command
    cmd = [
        "python", "-m", "tools.infer",
        "--text", text,
        "--reference-audio", voice_file,
        "--output", output_file,
        "--checkpoint", "checkpoints/fish-speech-1.5",
    ]

    try:
        result = subprocess.run(
            cmd,
            cwd=fish_speech_dir,
            capture_output=True,
            text=True,
            check=True
        )
        return True
    except subprocess.CalledProcessError as e:
        print(f"Error generating chunk: {e.stderr}")
        return False


def concatenate_audio_files(input_files: list[Path], output_file: Path):
    """Concatenate multiple audio files using ffmpeg."""

    # Create file list for ffmpeg
    list_file = output_file.parent / "concat_list.txt"
    with open(list_file, "w") as f:
        for audio_file in input_files:
            f.write(f"file '{audio_file}'\n")

    cmd = [
        "ffmpeg",
        "-f", "concat",
        "-safe", "0",
        "-i", str(list_file),
        "-c:a", "libmp3lame",
        "-b:a", "192k",
        "-y",
        str(output_file)
    ]

    subprocess.run(cmd, check=True, capture_output=True)

    # Cleanup
    list_file.unlink()


def main():
    parser = argparse.ArgumentParser(description="Generate audiobook with Fish Speech")
    parser.add_argument("--text", required=True, help="Path to text file")
    parser.add_argument("--voice", required=True, help="Path to voice sample (WAV/MP3)")
    parser.add_argument("--output", required=True, help="Output audiobook path")
    parser.add_argument("--chunk-size", type=int, default=500, help="Max characters per chunk")
    parser.add_argument("--fish-speech-dir", default="/workspace/fish-speech", help="Fish Speech directory")
    args = parser.parse_args()

    # Read text file
    print(f"Reading text from: {args.text}")
    with open(args.text, "r", encoding="utf-8") as f:
        full_text = f.read()

    print(f"Total text length: {len(full_text)} characters")

    # Split into chunks
    chunks = split_text_into_chunks(full_text, args.chunk_size)
    print(f"Split into {len(chunks)} chunks")

    # Create temp directory for chunks
    output_path = Path(args.output)
    temp_dir = output_path.parent / "temp_chunks"
    temp_dir.mkdir(exist_ok=True)

    # Generate audio for each chunk
    audio_files = []
    for i, chunk in enumerate(chunks):
        print(f"Generating chunk {i+1}/{len(chunks)}...")
        chunk_file = temp_dir / f"chunk_{i:04d}.wav"

        success = generate_audio_chunk(
            text=chunk,
            voice_file=args.voice,
            output_file=str(chunk_file),
            fish_speech_dir=args.fish_speech_dir
        )

        if success and chunk_file.exists():
            audio_files.append(chunk_file)
        else:
            print(f"Warning: Failed to generate chunk {i+1}")

    if not audio_files:
        print("Error: No audio files generated!")
        return

    # Concatenate all chunks
    print(f"Concatenating {len(audio_files)} audio files...")
    concatenate_audio_files(audio_files, output_path)

    # Cleanup temp files
    print("Cleaning up temporary files...")
    for f in audio_files:
        f.unlink()
    temp_dir.rmdir()

    print(f"Done! Audiobook saved to: {args.output}")

    # Print some stats
    import subprocess
    duration_cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(output_path)
    ]
    result = subprocess.run(duration_cmd, capture_output=True, text=True)
    if result.returncode == 0:
        duration = float(result.stdout.strip())
        hours = int(duration // 3600)
        minutes = int((duration % 3600) // 60)
        print(f"Audiobook duration: {hours}h {minutes}m")


if __name__ == "__main__":
    main()
