"""F5-TTS Provider via Replicate API - Voice cloning TTS"""

import os
import re
import time
from pathlib import Path
from typing import Optional
import logging
import replicate
import requests

from ..config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


class F5TTSProvider:
    """F5-TTS provider using Replicate Python SDK"""

    def __init__(self, api_token: Optional[str] = None):
        token = api_token or settings.replicate_api_token or os.getenv("REPLICATE_API_TOKEN")
        if token:
            os.environ["REPLICATE_API_TOKEN"] = token
        else:
            logger.warning("Replicate API token not configured")

        self.model = settings.f5tts_model

    def generate_audio(
        self,
        text: str,
        voice_sample_url: str,
        output_dir: str,
        ref_text: str = ""
    ) -> Path:
        """Generate audio using F5-TTS on Replicate"""
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        # Resolve voice sample path
        if voice_sample_url.startswith("file://"):
            voice_sample_url = voice_sample_url.replace("file://", "")

        voice_path = Path(voice_sample_url)
        if not voice_path.exists():
            raise ValueError(f"Voice sample not found: {voice_path}")

        # Split text into chunks
        max_chunk_chars = 4000
        chunks = self._split_text(text, max_chunk_chars)

        logger.info(f"Generating audio for {len(text)} chars in {len(chunks)} chunks via Replicate")

        audio_segments = []

        for i, chunk in enumerate(chunks):
            logger.info(f"Processing chunk {i+1}/{len(chunks)} ({len(chunk)} chars)")

            try:
                audio_url = self._call_replicate(chunk, voice_path, ref_text)

                if audio_url:
                    response = requests.get(audio_url)
                    response.raise_for_status()
                    audio_segments.append(response.content)
                else:
                    raise Exception("No audio output returned")

            except Exception as e:
                logger.error(f"Chunk {i+1} generation failed: {e}")
                raise

        # Concatenate and save
        full_audio = b''.join(audio_segments)
        output_path = output_dir / "audiobook.wav"

        with open(output_path, "wb") as f:
            f.write(full_audio)

        logger.info(f"Audio saved to: {output_path}")
        return output_path

    def _call_replicate(self, text: str, voice_path: Path, ref_text: str = "") -> Optional[str]:
        """Call F5-TTS via Replicate SDK"""
        with open(voice_path, "rb") as f:
            output = replicate.run(
                self.model,
                input={
                    "gen_text": text,
                    "ref_audio": f,
                    "ref_text": ref_text or "",
                    "model_type": "F5-TTS",
                    "remove_silence": True,
                }
            )

        # Output is typically a URL string or FileOutput
        if hasattr(output, 'url'):
            return output.url
        elif isinstance(output, str):
            return output
        else:
            # Could be a FileOutput object - convert to string
            return str(output)

    def _split_text(self, text: str, max_chars: int) -> list[str]:
        """Split text into chunks at sentence boundaries"""
        sentences = re.split(r'(?<=[.!?])\s+', text)
        sentences = [s.strip() for s in sentences if s.strip()]

        chunks = []
        current_chunk = ""

        for sentence in sentences:
            if len(current_chunk) + len(sentence) + 1 <= max_chars:
                current_chunk += sentence + " "
            else:
                if current_chunk:
                    chunks.append(current_chunk.strip())
                current_chunk = sentence + " "

        if current_chunk:
            chunks.append(current_chunk.strip())

        return chunks
