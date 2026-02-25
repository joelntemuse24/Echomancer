import subprocess
from pathlib import Path
from typing import Optional
import httpx
import uuid
import asyncio
from abc import ABC, abstractmethod


class TTSProvider(ABC):
    """Abstract base class for TTS providers."""

    @abstractmethod
    async def generate_audio(
        self,
        text: str,
        voice_sample_url: str,
        output_dir: str,
        ref_text: str = ""
    ) -> Path:
        """Generate audio from text using a voice sample."""
        pass


class VastAIF5TTSProvider(TTSProvider):
    """
    TTS provider using F5-TTS on Vast.ai (~$0.50-1.00 per 10hr audiobook).

    F5-TTS is the best open-source zero-shot voice cloning model (late 2025).
    - Excellent quality from 10-30s reference audio
    - ~10-20x realtime on RTX 4090
    - Great for audiobook generation

    Requires a running Vast.ai instance with F5-TTS installed.
    See vastai-scripts/README.md for setup instructions.
    """

    def __init__(self, vastai_url: str, api_key: str = ""):
        """
        Args:
            vastai_url: URL to your Vast.ai F5-TTS API endpoint
                       e.g., "http://123.456.789.10:8080"
            api_key: Optional API key for authentication
        """
        self.vastai_url = vastai_url.rstrip("/")
        self.api_key = api_key

    async def generate_audio(
        self,
        text: str,
        voice_sample_url: str,
        output_dir: str,
        ref_text: str = ""
    ) -> Path:
        """
        Generate audio using F5-TTS on Vast.ai.

        Args:
            text: The text to synthesize
            voice_sample_url: URL to the reference voice audio (10-30s clip)
            output_dir: Directory to save the output
            ref_text: Transcription of the reference audio (optional, uses ASR if empty)
        """
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)

        headers = {}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        async with httpx.AsyncClient(timeout=600.0) as client:
            response = await client.post(
                f"{self.vastai_url}/generate",
                json={
                    "text": text,
                    "voice_sample_url": voice_sample_url,
                    "ref_text": ref_text,
                },
                headers=headers,
            )
            response.raise_for_status()

            audio_file = output_path / f"{uuid.uuid4()}.wav"
            audio_file.write_bytes(response.content)

        return audio_file


class LocalF5TTSProvider(TTSProvider):
    """
    TTS provider using locally installed F5-TTS.

    Requires f5-tts to be installed: pip install f5-tts
    """

    def __init__(self, model: str = "F5TTS_v1_Base"):
        self.model = model

    async def generate_audio(
        self,
        text: str,
        voice_sample_url: str,
        output_dir: str,
        ref_text: str = ""
    ) -> Path:
        """
        Generate audio using local F5-TTS installation.
        """
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)

        # Download voice sample if it's a URL
        voice_file = output_path / "ref_voice.wav"
        if voice_sample_url.startswith(("http://", "https://")):
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.get(voice_sample_url)
                response.raise_for_status()
                voice_file.write_bytes(response.content)
        elif voice_sample_url.startswith("file://"):
            # Local file - copy directly
            # Handle file:// URLs properly for Windows
            file_path = voice_sample_url.replace("file:///", "").replace("file://", "")
            source_path = Path(file_path)
            voice_file.write_bytes(source_path.read_bytes())
        else:
            voice_file = Path(voice_sample_url)

        output_file = output_path / f"{uuid.uuid4()}.wav"

        # Build the F5-TTS command
        cmd = [
            "f5-tts_infer-cli",
            "--model", self.model,
            "--ref_audio", str(voice_file),
            "--gen_text", text,
            "--output_dir", str(output_path),
        ]

        if ref_text:
            cmd.extend(["--ref_text", ref_text])

        # Run F5-TTS
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()

        if process.returncode != 0:
            raise RuntimeError(f"F5-TTS failed: {stderr.decode()}")

        # F5-TTS outputs to output_dir with a generated name
        # Find the most recent .wav file
        wav_files = sorted(output_path.glob("*.wav"), key=lambda f: f.stat().st_mtime, reverse=True)
        if not wav_files:
            raise RuntimeError("F5-TTS did not generate any output")

        return wav_files[0]


class ReplicateTTSProvider(TTSProvider):
    """
    TTS provider using Fish Speech on Replicate.

    Cost: ~$0.10-0.50 per audiobook
    No GPU management needed - fully serverless
    """

    def __init__(self, api_token: str):
        """
        Args:
            api_token: Replicate API token from https://replicate.com/account/api-tokens
        """
        self.api_token = api_token

    async def generate_audio(
        self,
        text: str,
        voice_sample_url: str,
        output_dir: str,
        ref_text: str = ""
    ) -> Path:
        """
        Generate audio using Fish Speech on Replicate.

        Args:
            text: The text to synthesize
            voice_sample_url: URL to the reference voice audio
            output_dir: Directory to save the output
            ref_text: Transcription of reference audio (optional)
        """
        import replicate
        import os
        import base64

        # Set API token
        os.environ["REPLICATE_API_TOKEN"] = self.api_token

        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)

        # Handle local file paths - convert to data URI for Replicate
        reference_audio_input = voice_sample_url
        if voice_sample_url.startswith("file://"):
            # Local file - read and encode as base64 data URI
            # Handle file:// URLs properly for Windows
            file_path = voice_sample_url.replace("file:///", "").replace("file://", "")
            local_path = Path(file_path)
            audio_bytes = local_path.read_bytes()

            # Detect audio format from file extension
            ext = local_path.suffix.lower()
            mime_type = "audio/mpeg" if ext in [".mp3", ".mpeg"] else "audio/wav"

            # Create data URI
            b64_audio = base64.b64encode(audio_bytes).decode('utf-8')
            reference_audio_input = f"data:{mime_type};base64,{b64_audio}"

        # Run F5-TTS on Replicate (state-of-the-art open source voice cloning)
        # Using x-lance/f5-tts - best quality for voice cloning
        output = replicate.run(
            "x-lance/f5-tts",
            input={
                "gen_text": text,
                "ref_audio": reference_audio_input,
                "ref_text": ref_text if ref_text else "",
            }
        )

        # Download the generated audio
        audio_file = output_path / f"{uuid.uuid4()}.wav"

        async with httpx.AsyncClient(timeout=600.0) as client:
            response = await client.get(output)
            response.raise_for_status()
            audio_file.write_bytes(response.content)

        return audio_file


class ChatterboxTTSProvider(TTSProvider):
    """
    TTS provider using Chatterbox Turbo by Resemble AI.

    Best-in-class emotional TTS with zero-shot voice cloning.
    - Supports paralinguistic tags: [laugh], [sigh], [gasp], etc.
    - emotion_scale parameter for expressiveness control
    - ~10-20x realtime on RTX 4090
    - Runs locally on GPU (TensorDock, Vast.ai, etc.)

    Cost: ~$0.35/hr GPU rental = ~$0.10-0.30 per audiobook
    """

    _model = None  # Singleton - load once, reuse

    def __init__(self, device: str = "cuda", exaggeration: float = 0.5, cfg_weight: float = 0.5):
        """
        Args:
            device: "cuda" or "cpu"
            exaggeration: Emotion exaggeration level (0.0 = neutral, 1.0 = very expressive)
            cfg_weight: Classifier-free guidance weight (0.0 = more variable, 1.0 = more stable)
        """
        self.device = device
        self.exaggeration = exaggeration
        self.cfg_weight = cfg_weight

    def _get_model(self):
        """Lazy-load model as singleton to avoid repeated GPU memory allocation."""
        if ChatterboxTTSProvider._model is None:
            import torch
            from chatterbox.tts import ChatterboxTTS
            print(f"Loading Chatterbox TTS model on {self.device}...")
            ChatterboxTTSProvider._model = ChatterboxTTS.from_pretrained(device=self.device)
            print("Chatterbox TTS model loaded!")
        return ChatterboxTTSProvider._model

    def _resolve_voice_file(self, voice_sample_url: str, output_dir: Path) -> Path:
        """Download or resolve voice sample to a local file path."""
        voice_file = output_dir / "ref_voice.wav"

        if voice_sample_url.startswith(("http://", "https://")):
            import httpx as httpx_sync
            with httpx_sync.Client(timeout=60.0) as client:
                response = client.get(voice_sample_url)
                response.raise_for_status()
                voice_file.write_bytes(response.content)
        elif voice_sample_url.startswith("file://"):
            file_path = voice_sample_url.replace("file:///", "").replace("file://", "")
            source_path = Path(file_path)
            voice_file.write_bytes(source_path.read_bytes())
        else:
            # Assume it's a direct file path
            voice_file = Path(voice_sample_url)

        return voice_file

    async def generate_audio(
        self,
        text: str,
        voice_sample_url: str,
        output_dir: str,
        ref_text: str = ""
    ) -> Path:
        """
        Generate audio using Chatterbox Turbo TTS.

        Args:
            text: Text to synthesize (supports tags like [laugh], [sigh])
            voice_sample_url: URL or path to reference voice audio (5-30s)
            output_dir: Directory to save the output
            ref_text: Not used by Chatterbox (auto-transcribes), kept for interface compat
        """
        import torch
        import torchaudio

        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)

        # Resolve voice file to local path
        voice_file = self._resolve_voice_file(voice_sample_url, output_path)

        # Load model (singleton)
        model = self._get_model()

        # Generate audio - run in thread to not block event loop
        loop = asyncio.get_event_loop()
        audio_file = output_path / f"{uuid.uuid4()}.wav"

        def _generate():
            wav = model.generate(
                text=text,
                audio_prompt_path=str(voice_file),
                exaggeration=self.exaggeration,
                cfg_weight=self.cfg_weight,
            )
            torchaudio.save(str(audio_file), wav, model.sr)
            return audio_file

        result = await loop.run_in_executor(None, _generate)

        # Clean up GPU cache periodically
        torch.cuda.empty_cache()

        return result


class MockTTSProvider(TTSProvider):
    """Mock TTS provider for testing without API calls."""

    async def generate_audio(
        self,
        text: str,
        voice_sample_url: str,
        output_dir: str,
        ref_text: str = ""
    ) -> Path:
        """Generate a placeholder audio file for testing."""
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)

        audio_file = output_path / f"{uuid.uuid4()}_mock.wav"
        audio_file.write_bytes(b"mock audio content")

        return audio_file


def get_tts_provider(
    provider_type: str = "vastai",
    vastai_url: str = "",
    vastai_key: str = "",
    replicate_token: str = "",
    local_model: str = "F5TTS_v1_Base",
    chatterbox_device: str = "cuda",
    chatterbox_exaggeration: float = 0.5,
    chatterbox_cfg_weight: float = 0.5,
) -> TTSProvider:
    """
    Factory function to get the appropriate TTS provider.

    Args:
        provider_type: "chatterbox", "replicate", "vastai", "local", or "mock"
        vastai_url: Vast.ai instance URL (for vastai provider)
        vastai_key: Vast.ai API key (for vastai provider)
        replicate_token: Replicate API token (for replicate provider)
        local_model: Model name for local F5-TTS
        chatterbox_device: Device for Chatterbox ("cuda" or "cpu")
        chatterbox_exaggeration: Emotion exaggeration (0.0-1.0)
        chatterbox_cfg_weight: CFG weight for Chatterbox (0.0-1.0)
    """
    if provider_type == "chatterbox":
        return ChatterboxTTSProvider(
            device=chatterbox_device,
            exaggeration=chatterbox_exaggeration,
            cfg_weight=chatterbox_cfg_weight,
        )
    elif provider_type == "replicate" and replicate_token:
        return ReplicateTTSProvider(replicate_token)
    elif provider_type == "vastai" and vastai_url:
        return VastAIF5TTSProvider(vastai_url, vastai_key)
    elif provider_type == "local":
        return LocalF5TTSProvider(local_model)
    else:
        return MockTTSProvider()


async def generate_audiobook(
    text: str,
    voice_sample_url: str,
    output_dir: str,
    provider_type: str = "vastai",
    vastai_url: str = "",
    vastai_key: str = "",
    replicate_token: str = "",
    ref_text: str = "",
    chunk_size: int = 500,
    parallel_chunks: int = 4,
) -> Path:
    """
    Generate a full audiobook from text using F5-TTS.

    For long texts, this splits into chunks and generates each separately,
    optionally in parallel, then concatenates them.

    Args:
        text: Full text to convert
        voice_sample_url: URL to voice sample (10-30s reference clip)
        output_dir: Output directory
        provider_type: "vastai", "local", or "mock"
        vastai_url: Vast.ai instance URL
        vastai_key: Vast.ai API key
        ref_text: Transcription of reference audio (optional)
        chunk_size: Max characters per TTS call (500 recommended for quality)
        parallel_chunks: Number of chunks to process in parallel

    Returns:
        Path to final audio file
    """
    provider = get_tts_provider(
        provider_type=provider_type,
        vastai_url=vastai_url,
        vastai_key=vastai_key,
        replicate_token=replicate_token,
    )

    # For shorter texts, generate in one go
    if len(text) <= chunk_size:
        return await provider.generate_audio(text, voice_sample_url, output_dir, ref_text)

    # For longer texts, split into chunks at sentence boundaries
    chunks = split_text_into_chunks(text, chunk_size)
    audio_files = []

    # Process chunks in parallel batches
    for batch_start in range(0, len(chunks), parallel_chunks):
        batch = chunks[batch_start:batch_start + parallel_chunks]
        print(f"Generating chunks {batch_start + 1}-{batch_start + len(batch)}/{len(chunks)}...")

        tasks = [
            provider.generate_audio(chunk, voice_sample_url, output_dir, ref_text)
            for chunk in batch
        ]
        batch_results = await asyncio.gather(*tasks)
        audio_files.extend(batch_results)

    # Concatenate all audio files
    from .audio import concatenate_audio_files
    final_file = Path(output_dir) / f"{uuid.uuid4()}_full.wav"
    await concatenate_audio_files(audio_files, final_file)

    # Clean up chunk files
    for f in audio_files:
        f.unlink(missing_ok=True)

    return final_file


def split_text_into_chunks(text: str, max_chunk_size: int) -> list[str]:
    """Split text into chunks at sentence boundaries."""
    import re

    # Split on sentence endings
    sentences = re.split(r'(?<=[.!?])\s+', text)
    chunks = []
    current_chunk = ""

    for sentence in sentences:
        # Handle sentences longer than max chunk size
        if len(sentence) > max_chunk_size:
            if current_chunk:
                chunks.append(current_chunk.strip())
                current_chunk = ""
            # Split long sentence by commas or spaces
            words = sentence.split()
            temp = ""
            for word in words:
                if len(temp) + len(word) + 1 <= max_chunk_size:
                    temp += word + " "
                else:
                    if temp:
                        chunks.append(temp.strip())
                    temp = word + " "
            if temp:
                chunks.append(temp.strip())
            continue

        if len(current_chunk) + len(sentence) + 1 <= max_chunk_size:
            current_chunk += sentence + " "
        else:
            if current_chunk:
                chunks.append(current_chunk.strip())
            current_chunk = sentence + " "

    if current_chunk:
        chunks.append(current_chunk.strip())

    return chunks
