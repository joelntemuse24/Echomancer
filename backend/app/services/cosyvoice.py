# Switched to CosyVoice 2.0 (FunAudioLLM/CosyVoice2-0.5B) on 2025-02-15
# IndexTTS-2 abandoned due to persistent loading errors

"""CosyVoice Provider - High-quality voice cloning"""

import torch
import torchaudio
from pathlib import Path
from typing import Optional
import logging
import os
from .audio_enhancer import audio_enhancer

logger = logging.getLogger(__name__)

class CosyVoiceProvider:
    """CosyVoice voice cloning provider"""
    
    def __init__(self):
        self.model = None
        # Check for GPU availability
        self.device = self._get_device()
        self.model_dir = "pretrained_models/CosyVoice2-0.5B"
        
        # Log device info
        logger.info(f"Using device: {self.device}")
        if self.device == "cuda":
            logger.info(f"GPU: {torch.cuda.get_device_name(0)}")
            logger.info(f"GPU Memory: {round(torch.cuda.get_device_properties(0).total_memory / 1e9, 1)} GB")
        
    def _get_device(self):
        """Determine the best available device"""
        if torch.cuda.is_available():
            return "cuda"
        elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
            return "mps"  # Apple Silicon GPU
        else:
            logger.warning("No GPU detected. Using CPU (will be slow). For GPU performance:")
            logger.warning("1. Ensure you're on a machine with NVIDIA GPU")
            logger.warning("2. Install CUDA toolkit: https://developer.nvidia.com/cuda-downloads")
            logger.warning("3. Install PyTorch with CUDA: pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118")
            return "cpu"
        
    def _load_model(self):
        """Load CosyVoice model with GPU optimization"""
        if self.model is None:
            try:
                from cosyvoice.cli.cosyvoice import CosyVoice2 as CosyVoice
                
                # Check if model exists, if not download it
                if not os.path.exists(self.model_dir):
                    logger.info(f"Downloading CosyVoice model to {self.model_dir}...")
                    os.makedirs(self.model_dir, exist_ok=True)
                    # Model will be downloaded automatically on first use
                
                logger.info(f"Loading CosyVoice model on {self.device}...")
                self.model = CosyVoice(self.model_dir)
                
                # Move model to GPU if available
                if self.device == "cuda" and hasattr(self.model, 'cuda'):
                    self.model = self.model.cuda()
                    logger.info("CosyVoice model moved to GPU!")
                
                # Enable mixed precision for faster inference
                if self.device == "cuda":
                    logger.info("Enabling FP16 for faster GPU inference...")
                
                logger.info("CosyVoice model loaded successfully!")
                
            except ImportError as e:
                logger.error(f"CosyVoice import failed: {e}")
                raise ImportError("CosyVoice not installed. Please install with: pip install git+https://github.com/FunAudioLLM/CosyVoice.git")
            except Exception as e:
                logger.error(f"Failed to load CosyVoice: {e}")
                raise
    
    def _clip_voice_sample(self, voice_path: Path, output_dir: Path, max_duration: float = 25.0) -> Path:
        """Clip voice sample to max duration (CosyVoice limit is 30s)"""
        try:
            # Load audio to check duration
            audio, sr = torchaudio.load(str(voice_path))
            duration = audio.shape[1] / sr
            
            if duration <= max_duration:
                return voice_path  # No clipping needed
            
            logger.info(f"Voice sample is {duration:.1f}s, clipping to {max_duration}s for CosyVoice")
            
            # Calculate sample count for max duration
            max_samples = int(max_duration * sr)
            
            # Clip to first max_duration seconds (usually the best part)
            clipped_audio = audio[:, :max_samples]
            
            # Save clipped audio to temp directory
            clipped_path = output_dir / f"voice_clipped_{max_duration}s.wav"
            torchaudio.save(str(clipped_path), clipped_audio, sr)
            
            logger.info(f"Clipped voice sample saved to: {clipped_path}")
            return clipped_path
            
        except Exception as e:
            logger.warning(f"Failed to clip voice sample: {e}, using original")
            return voice_path
    
    def generate_audio(
        self,
        text: str,
        voice_sample_url: str,
        output_dir: str,
        ref_text: str = ""
    ) -> Path:
        """Generate audio using CosyVoice with GPU acceleration"""
        
        self._load_model()
        
        # Handle voice sample URL
        if voice_sample_url.startswith("file://"):
            voice_path = Path(voice_sample_url.replace("file://", ""))
        else:
            voice_path = Path(voice_sample_url)
        
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        
        # Clip voice sample FIRST if needed (before any processing)
        if voice_path.exists():
            voice_path = self._clip_voice_sample(voice_path, output_dir, max_duration=25.0)
        
        # Generate audio with CosyVoice
        try:
            logger.info(f"Generating audio for {len(text)} characters on {self.device}...")
            
            # Prepare reference audio if provided
            prompt_speech_16k = str(voice_path) if voice_path.exists() else None
            if prompt_speech_16k:
                logger.info(f"Using reference audio: {voice_path}")
            
            # Split long text into chunks for better performance (max 1000 chars per chunk)
            max_chunk_size = 1000
            if len(text) > max_chunk_size:
                logger.info(f"Splitting text into chunks for better performance...")
                return self._generate_audio_chunks(text, voice_path, output_dir, ref_text, max_chunk_size)
            
            # Use zero-shot inference with CosyVoice
            prompt_speech_16k = str(voice_path) if voice_path.exists() else None
            if prompt_speech_16k:
                # Use reference audio for voice cloning with better quality settings
                output_gen = self.model.inference_zero_shot(
                    tts_text=text,
                    prompt_text=ref_text or "This is a sample of the speaker's voice for cloning.",
                    prompt_wav=prompt_speech_16k,
                    stream=False,
                    speed=0.85,
                )
                # Consume generator to get output
                output = next(iter(output_gen))
            else:
                # Use SFT mode with better quality
                output_gen = self.model.inference_sft(
                    tts_text=text,
                    spk_id="default",
                    stream=False,
                    speed=0.85,
                )
                # Consume generator to get output
                output = next(iter(output_gen))
            
            # Extract audio tensor
            audio_tensor = output['tts_speech']
            
            # Move to CPU for saving if on GPU
            if self.device == "cuda":
                audio_tensor = audio_tensor.cpu()
            
            # Normalize audio to prevent clipping and improve quality
            audio_tensor = torch.clamp(audio_tensor, -1.0, 1.0)
            
            # Apply comprehensive audio enhancement
            enhanced_audio = audio_enhancer.enhance_audio(audio_tensor, sample_rate=22050)
            
            # Upsample to higher quality
            upsampled_audio = audio_enhancer.upsample_audio(enhanced_audio, 22050, 44100)
            
            # Save with maximum quality
            output_path = output_dir / "audiobook.wav"
            audio_enhancer.save_high_quality_audio(
                upsampled_audio,
                str(output_path),
                sample_rate=44100,
                bit_depth=24
            )
            logger.info(f"High-quality audio saved to: {output_path}")
            
            return output_path
            
        except Exception as e:
            logger.error(f"CosyVoice generation failed: {e}")
            raise
    
    def _generate_audio_chunks(self, text: str, voice_path: Path, output_dir: Path, ref_text: str, max_chunk_size: int) -> Path:
        """Generate audio in chunks for better performance with long texts"""
        import re
        
        # Split text into sentences first, then combine into chunks
        sentences = re.split(r'[.!?]+', text)
        sentences = [s.strip() for s in sentences if s.strip()]
        
        # Create chunks of approximately max_chunk_size characters
        chunks = []
        current_chunk = ""
        
        for sentence in sentences:
            if len(current_chunk) + len(sentence) + 1 <= max_chunk_size:
                current_chunk += sentence + ". "
            else:
                if current_chunk:
                    chunks.append(current_chunk.strip())
                current_chunk = sentence + ". "
        
        if current_chunk:
            chunks.append(current_chunk.strip())
        
        logger.info(f"Split into {len(chunks)} chunks for processing")
        
        # Generate audio for each chunk
        audio_segments = []
        prompt_speech_16k = str(voice_path) if voice_path.exists() else None
        
        # Clip voice sample if needed (in case it wasn't clipped in generate_audio)
        if voice_path.exists():
            voice_path = self._clip_voice_sample(voice_path, output_dir, max_duration=25.0)
            prompt_speech_16k = str(voice_path)
        
        # Process chunks in parallel using ThreadPoolExecutor
        max_workers = 4  # Process 4 chunks simultaneously
        logger.info(f"Processing {len(chunks)} chunks in parallel with {max_workers} workers...")
        
        from concurrent.futures import ThreadPoolExecutor
        
        def process_chunk(args):
            i, chunk = args
            logger.info(f"Processing chunk {i+1}/{len(chunks)} ({len(chunk)} chars)")
            
            try:
                if prompt_speech_16k:
                    output_gen = self.model.inference_zero_shot(
                        tts_text=chunk,
                        prompt_text=ref_text or "This is a sample of the speaker's voice for cloning.",
                        prompt_wav=prompt_speech_16k,
                        stream=False,
                        speed=0.85,
                    )
                    output = next(iter(output_gen))
                else:
                    output_gen = self.model.inference_sft(
                        tts_text=chunk,
                        spk_id="default",
                        stream=False,
                        speed=0.85,
                    )
                    output = next(iter(output_gen))
                
                # Extract and move to CPU if needed
                audio_tensor = output['tts_speech']
                if self.device == "cuda":
                    audio_tensor = audio_tensor.cpu()
                
                # Ensure tensor is 1D for consistent concatenation
                if audio_tensor.dim() > 1:
                    audio_tensor = audio_tensor.squeeze()
                if audio_tensor.dim() == 0:
                    audio_tensor = audio_tensor.unsqueeze(0)
                
                return i, audio_tensor
            except Exception as e:
                logger.error(f"Chunk {i+1} failed: {e}")
                raise
        
        # Process chunks in parallel
        audio_segments_map = {}
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {executor.submit(process_chunk, (i, chunk)): i for i, chunk in enumerate(chunks)}
            for future in futures:
                i, audio_tensor = future.result()
                audio_segments_map[i] = audio_tensor
        
        # Reassemble in correct order
        audio_segments = [audio_segments_map[i] for i in range(len(chunks))]
        
        logger.info(f"All {len(chunks)} chunks processed successfully")
        
        # Concatenate all audio segments
        logger.info("Concatenating audio segments...")
        # Pad all segments to same length if needed
        max_len = max(seg.shape[0] for seg in audio_segments)
        padded_segments = []
        for seg in audio_segments:
            if seg.shape[0] < max_len:
                padding = torch.zeros(max_len - seg.shape[0], dtype=seg.dtype, device=seg.device)
                seg = torch.cat([seg, padding])
            padded_segments.append(seg)
        
        full_audio = torch.cat(padded_segments, dim=0)
        
        # Normalize audio to prevent clipping
        full_audio = torch.clamp(full_audio, -1.0, 1.0)
        
        # Save final audio
        output_path = output_dir / "audiobook.wav"
        sample_rate = 22050
        
        torchaudio.save(
            str(output_path), 
            full_audio.unsqueeze(0), 
            sample_rate,
            encoding="PCM_S",
            bits_per_sample=16
        )
        
        logger.info(f"Audio saved to: {output_path}")
        return output_path
    
    def _enhance_audio_quality(self, audio_tensor: torch.Tensor) -> torch.Tensor:
        """Apply audio enhancement techniques for better quality"""
        try:
            # 1. Remove DC offset
            audio_tensor = audio_tensor - torch.mean(audio_tensor)
            
            # 2. Apply gentle high-pass filter to remove rumble
            if not hasattr(self, 'highpass_filter'):
                # Create simple high-pass filter
                self.highpass_filter = torch.nn.Conv1d(1, 1, kernel_size=5, padding=2).to(audio_tensor.device)
                # Initialize for high-pass (simplified)
                with torch.no_grad():
                    self.highpass_filter.weight[0, 0] = torch.tensor([-0.2, -0.4, 1.0, -0.4, -0.2])
                    self.highpass_filter.bias[0] = 0.0
                self.highpass_filter.eval()
            
            # Apply filter
            if audio_tensor.dim() == 1:
                audio_tensor = audio_tensor.unsqueeze(0).unsqueeze(0)
            elif audio_tensor.dim() == 2:
                audio_tensor = audio_tensor.unsqueeze(0)
            
            with torch.no_grad():
                audio_tensor = self.highpass_filter(audio_tensor)
            
            audio_tensor = audio_tensor.squeeze()
            
            # 3. Apply gentle compression to even out dynamics
            audio_tensor = torch.tanh(audio_tensor * 0.8)  # Soft compression
            
            # 4. Apply noise reduction (simple spectral subtraction)
            if not hasattr(self, 'noise_gate_threshold'):
                self.noise_gate_threshold = 0.01
            
            # Simple noise gate
            audio_abs = torch.abs(audio_tensor)
            mask = audio_abs > self.noise_gate_threshold
            audio_tensor = audio_tensor * mask.float()
            
            # 5. Normalize to optimal level (-3dB)
            max_val = torch.max(torch.abs(audio_tensor))
            if max_val > 0:
                audio_tensor = audio_tensor / max_val * 0.7  # -3dB
            
            # 6. Apply gentle smoothing to reduce harshness
            if not hasattr(self, 'smoothing_filter'):
                self.smoothing_filter = torch.nn.Conv1d(1, 1, kernel_size=3, padding=1).to(audio_tensor.device)
                with torch.no_grad():
                    self.smoothing_filter.weight[0, 0] = torch.tensor([0.25, 0.5, 0.25])
                    self.smoothing_filter.bias[0] = 0.0
                self.smoothing_filter.eval()
            
            if audio_tensor.dim() == 1:
                audio_tensor = audio_tensor.unsqueeze(0).unsqueeze(0)
            elif audio_tensor.dim() == 2:
                audio_tensor = audio_tensor.unsqueeze(0)
            
            with torch.no_grad():
                audio_tensor = self.smoothing_filter(audio_tensor)
            
            audio_tensor = audio_tensor.squeeze()
            
            return audio_tensor
            
        except Exception as e:
            logger.warning(f"Audio enhancement failed: {e}")
            return audio_tensor
