"""TTS Provider Factory - F5-TTS via Replicate"""

import os
from pathlib import Path
from typing import Optional

from .f5tts import F5TTSProvider


class TTSProvider:
    """Base class for TTS providers."""

    def generate_audio(
        self,
        text: str,
        voice_sample_url: str,
        output_dir: str,
        ref_text: str = ""
    ) -> Path:
        raise NotImplementedError


def get_tts_provider() -> TTSProvider:
    """Get F5-TTS Replicate provider instance"""
    return F5TTSProvider()
