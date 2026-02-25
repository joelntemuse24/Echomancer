"""F5-TTS Provider via Replicate API - Fast, high-quality voice cloning"""

import os
import re
import time
from pathlib import Path
from typing import Optional
import logging
import requests

from ..config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


class F5TTSProvider:
    """F5-TTS provider using Replicate API for voice cloning"""
    
    def __init__(self, api_token: Optional[str] = None):
        self.api_token = api_token or settings.replicate_api_token or os.getenv("REPLICATE_API_TOKEN")
        self.model = "lucataco/f5-tts:9d976d38f905ee0c7631c947e1ad99ef57a52f5fa1a9eb7a6c96a1d61ed1f5a2"
        
        if not self.api_token:
            logger.warning("Replicate API token not configured")
        
    def _get_headers(self):
        """Get Replicate API headers"""
        return {
            "Authorization": f"Token {self.api_token}",
            "Content-Type": "application/json"
        }
    
    def clone_voice(self, voice_sample_path: str, name: str = "cloned_voice") -> str:
        """Voice cloning is done inline with generation for F5-TTS"""
        logger.info(f"Voice sample ready: {voice_sample_path}")
        return voice_sample_path
    
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
        
        # Handle voice sample URL
        if voice_sample_url.startswith("file://"):
            voice_sample_url = voice_sample_url.replace("file://", "")
        
        voice_path = Path(voice_sample_url)
        if not voice_path.exists():
            raise ValueError(f"Voice sample not found: {voice_path}")
        
        # Upload voice sample to a temporary URL (Replicate needs public URL)
        # For now, we'll use the file directly with Replicate's API
        # Replicate supports file uploads in the request
        
        # Split text into chunks (F5-TTS has limits)
        max_chunk_chars = 4000  # F5-TTS practical limit
        chunks = self._split_text(text, max_chunk_chars)
        
        logger.info(f"Generating audio for {len(text)} chars in {len(chunks)} chunks via Replicate")
        
        audio_segments = []
        
        for i, chunk in enumerate(chunks):
            logger.info(f"Processing chunk {i+1}/{len(chunks)} ({len(chunk)} chars)")
            
            try:
                # Read voice sample as base64 or upload to temporary storage
                with open(voice_path, "rb") as f:
                    voice_data = f.read()
                
                # For Replicate, we need to upload the file to a URL first
                # Or use data URI - let's use a simpler approach with Replicate's API
                audio_url = self._call_replicate_api(chunk, voice_path, ref_text)
                
                if audio_url:
                    # Download the generated audio
                    audio_data = self._download_audio(audio_url)
                    audio_segments.append(audio_data)
                else:
                    raise Exception("Failed to generate audio chunk")
                
            except Exception as e:
                logger.error(f"Chunk {i+1} generation failed: {e}")
                raise
        
        # Concatenate all audio segments
        logger.info("Concatenating audio segments...")
        full_audio = b''.join(audio_segments)
        
        # Save audio file
        output_path = output_dir / "audiobook.wav"
        
        with open(output_path, "wb") as f:
            f.write(full_audio)
        
        logger.info(f"Audio saved to: {output_path}")
        return output_path
    
    def _call_replicate_api(self, text: str, voice_path: Path, ref_text: str = "") -> Optional[str]:
        """Call Replicate F5-TTS API"""
        import base64
        
        headers = self._get_headers()
        
        # Read voice file and encode as base64 for data URI
        with open(voice_path, "rb") as f:
            voice_bytes = f.read()
        
        # Detect file type
        suffix = voice_path.suffix.lower()
        if suffix == ".wav":
            mime_type = "audio/wav"
        elif suffix == ".mp3":
            mime_type = "audio/mp3"
        else:
            mime_type = "audio/wav"
        
        # Create data URI
        voice_base64 = base64.b64encode(voice_bytes).decode('utf-8')
        voice_data_uri = f"data:{mime_type};base64,{voice_base64}"
        
        # Prepare payload
        payload = {
            "version": self.model.split(":")[1],
            "input": {
                "gen_text": text,
                "ref_text": ref_text or "This is a reference voice sample for cloning.",
                "ref_audio": voice_data_uri,
                "remove_silence": True
            }
        }
        
        # Start prediction
        response = requests.post(
            "https://api.replicate.com/v1/predictions",
            headers=headers,
            json=payload
        )
        response.raise_for_status()
        
        prediction = response.json()
        prediction_id = prediction["id"]
        
        logger.info(f"Prediction started: {prediction_id}")
        
        # Poll for completion
        max_retries = 300  # 5 minutes max
        for i in range(max_retries):
            time.sleep(1)
            
            status_response = requests.get(
                f"https://api.replicate.com/v1/predictions/{prediction_id}",
                headers=headers
            )
            status_response.raise_for_status()
            
            status_data = status_response.json()
            status = status_data.get("status")
            
            if status == "succeeded":
                output_url = status_data.get("output")
                logger.info(f"Prediction completed: {prediction_id}")
                return output_url
            elif status == "failed":
                error = status_data.get("error", "Unknown error")
                logger.error(f"Prediction failed: {error}")
                raise Exception(f"F5-TTS generation failed: {error}")
            elif status == "canceled":
                raise Exception("F5-TTS generation was canceled")
        
        raise Exception("F5-TTS generation timed out")
    
    def _download_audio(self, url: str) -> bytes:
        """Download audio from URL"""
        response = requests.get(url)
        response.raise_for_status()
        return response.content
    
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
