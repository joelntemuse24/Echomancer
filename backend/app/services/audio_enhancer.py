import torch
import torchaudio
import logging
import numpy as np
from typing import Optional

logger = logging.getLogger(__name__)

class AudioEnhancer:
    """Professional audio quality enhancement for TTS output"""
    
    def __init__(self, device: str = "cuda"):
        self.device = torch.device(device if torch.cuda.is_available() else "cpu")
        self._initialize_filters()
    
    def _initialize_filters(self):
        """Initialize audio processing filters"""
        # High-pass filter to remove low-frequency rumble
        self.highpass_filter = torch.nn.Conv1d(1, 1, kernel_size=5, padding=2).to(self.device)
        with torch.no_grad():
            # High-pass filter coefficients (simple implementation)
            self.highpass_filter.weight[0, 0] = torch.tensor([-0.2, -0.4, 1.0, -0.4, -0.2])
            self.highpass_filter.bias[0] = 0.0
        self.highpass_filter.eval()
        
        # Smoothing filter to reduce harshness
        self.smoothing_filter = torch.nn.Conv1d(1, 1, kernel_size=3, padding=1).to(self.device)
        with torch.no_grad():
            self.smoothing_filter.weight[0, 0] = torch.tensor([0.25, 0.5, 0.25])
            self.smoothing_filter.bias[0] = 0.0
        self.smoothing_filter.eval()
        
        # De-esser filter to reduce sibilance (simplified)
        self.deesser_filter = torch.nn.Conv1d(1, 1, kernel_size=7, padding=3).to(self.device)
        with torch.no_grad():
            # High-frequency emphasis for de-essing
            self.deesser_filter.weight[0, 0] = torch.tensor([0.1, 0.2, -0.4, 0.8, -0.4, 0.2, 0.1])
            self.deesser_filter.bias[0] = 0.0
        self.deesser_filter.eval()
    
    def enhance_audio(self, audio_tensor: torch.Tensor, sample_rate: int = 22050) -> torch.Tensor:
        """Apply comprehensive audio enhancement"""
        try:
            logger.info("Applying audio enhancement...")
            
            # Step 1: Remove DC offset
            audio_tensor = self._remove_dc_offset(audio_tensor)
            
            # Step 2: Apply high-pass filter to remove rumble
            audio_tensor = self._apply_highpass_filter(audio_tensor)
            
            # Step 3: Apply de-essing to reduce sibilance
            audio_tensor = self._apply_deessing(audio_tensor)
            
            # Step 4: Apply gentle compression
            audio_tensor = self._apply_compression(audio_tensor)
            
            # Step 5: Apply noise reduction
            audio_tensor = self._apply_noise_reduction(audio_tensor)
            
            # Step 6: Apply smoothing to reduce harshness
            audio_tensor = self._apply_smoothing(audio_tensor)
            
            # Step 7: Normalize to optimal level
            audio_tensor = self._normalize_audio(audio_tensor)
            
            # Step 8: Apply subtle reverb for naturalness (optional)
            audio_tensor = self._apply_subtle_reverb(audio_tensor, sample_rate)
            
            logger.info("Audio enhancement completed successfully")
            return audio_tensor
            
        except Exception as e:
            logger.error(f"Audio enhancement failed: {e}")
            return audio_tensor
    
    def _remove_dc_offset(self, audio_tensor: torch.Tensor) -> torch.Tensor:
        """Remove DC offset from audio"""
        dc_offset = torch.mean(audio_tensor)
        return audio_tensor - dc_offset
    
    def _apply_highpass_filter(self, audio_tensor: torch.Tensor) -> torch.Tensor:
        """Apply high-pass filter to remove low-frequency rumble"""
        if audio_tensor.dim() == 1:
            audio_tensor = audio_tensor.unsqueeze(0).unsqueeze(0)
        elif audio_tensor.dim() == 2:
            audio_tensor = audio_tensor.unsqueeze(0)
        
        with torch.no_grad():
            audio_tensor = self.highpass_filter(audio_tensor)
        
        return audio_tensor.squeeze()
    
    def _apply_deessing(self, audio_tensor: torch.Tensor) -> torch.Tensor:
        """Apply de-essing to reduce sibilance"""
        if audio_tensor.dim() == 1:
            audio_tensor = audio_tensor.unsqueeze(0).unsqueeze(0)
        elif audio_tensor.dim() == 2:
            audio_tensor = audio_tensor.unsqueeze(0)
        
        with torch.no_grad():
            filtered = self.deesser_filter(audio_tensor)
            # Blend with original based on high-frequency content
            high_freq_energy = torch.mean(torch.abs(filtered))
            blend_factor = torch.clamp(high_freq_energy * 2, 0, 0.3)  # Max 30% de-essing
            audio_tensor = audio_tensor * (1 - blend_factor) + filtered * blend_factor
        
        return audio_tensor.squeeze()
    
    def _apply_compression(self, audio_tensor: torch.Tensor) -> torch.Tensor:
        """Apply gentle compression to even out dynamics"""
        # Soft compression using tanh
        compressed = torch.tanh(audio_tensor * 0.8)
        
        # Blend compressed with original
        blend_factor = 0.3  # 30% compression
        return audio_tensor * (1 - blend_factor) + compressed * blend_factor
    
    def _apply_noise_reduction(self, audio_tensor: torch.Tensor) -> torch.Tensor:
        """Apply noise reduction using spectral gating"""
        noise_gate_threshold = 0.01
        
        # Simple noise gate
        audio_abs = torch.abs(audio_tensor)
        mask = audio_abs > noise_gate_threshold
        
        # Smooth the mask to avoid harsh cutoffs
        if not hasattr(self, 'mask_smoother'):
            self.mask_smoother = torch.nn.Conv1d(1, 1, kernel_size=5, padding=2).to(self.device)
            with torch.no_grad():
                self.mask_smoother.weight[0, 0] = torch.tensor([0.1, 0.2, 0.4, 0.2, 0.1])
                self.mask_smoother.bias[0] = 0.0
            self.mask_smoother.eval()
        
        mask_float = mask.float().unsqueeze(0).unsqueeze(0)
        with torch.no_grad():
            mask_float = self.mask_smoother(mask_float)
        
        mask_float = mask_float.squeeze()
        
        return audio_tensor * mask_float
    
    def _apply_smoothing(self, audio_tensor: torch.Tensor) -> torch.Tensor:
        """Apply smoothing filter to reduce harshness"""
        if audio_tensor.dim() == 1:
            audio_tensor = audio_tensor.unsqueeze(0).unsqueeze(0)
        elif audio_tensor.dim() == 2:
            audio_tensor = audio_tensor.unsqueeze(0)
        
        with torch.no_grad():
            audio_tensor = self.smoothing_filter(audio_tensor)
        
        return audio_tensor.squeeze()
    
    def _normalize_audio(self, audio_tensor: torch.Tensor) -> torch.Tensor:
        """Normalize audio to optimal level"""
        max_val = torch.max(torch.abs(audio_tensor))
        if max_val > 0:
            # Normalize to -3dB (0.7) for headroom
            audio_tensor = audio_tensor / max_val * 0.7
        return audio_tensor
    
    def _apply_subtle_reverb(self, audio_tensor: torch.Tensor, sample_rate: int) -> torch.Tensor:
        """Apply very subtle reverb for naturalness"""
        try:
            # Create a simple delay-based reverb
            delay_samples = int(sample_rate * 0.03)  # 30ms delay
            decay_factor = 0.3
            
            if len(audio_tensor) > delay_samples:
                # Create delayed version
                delayed = torch.zeros_like(audio_tensor)
                delayed[delay_samples:] = audio_tensor[:-delay_samples] * decay_factor
                
                # Mix with original (very subtle)
                reverb_mix = 0.05  # 5% reverb
                audio_tensor = audio_tensor * (1 - reverb_mix) + delayed * reverb_mix
            
            return audio_tensor
            
        except Exception as e:
            logger.warning(f"Reverb application failed: {e}")
            return audio_tensor
    
    def upsample_audio(self, audio_tensor: torch.Tensor, original_sr: int, target_sr: int = 44100) -> torch.Tensor:
        """Upsample audio to higher sample rate for better quality"""
        if original_sr == target_sr:
            return audio_tensor
        
        if not hasattr(self, 'upsampler') or self.upsampler_orig_sr != original_sr:
            self.upsampler = torchaudio.transforms.Resample(original_sr, target_sr).to(self.device)
            self.upsampler_orig_sr = original_sr
        
        # Resample
        if audio_tensor.dim() == 1:
            audio_tensor = audio_tensor.unsqueeze(0)
        
        upsampled = self.upsampler(audio_tensor)
        
        return upsampled.squeeze()
    
    def save_high_quality_audio(
        self, 
        audio_tensor: torch.Tensor, 
        output_path: str, 
        sample_rate: int = 44100,
        bit_depth: int = 24
    ) -> None:
        """Save audio with maximum quality settings"""
        try:
            # Ensure audio is in the right format
            if audio_tensor.device.type == 'cuda':
                audio_tensor = audio_tensor.cpu()
            
            if audio_tensor.dim() == 1:
                audio_tensor = audio_tensor.unsqueeze(0)
            
            # Save with highest quality settings
            torchaudio.save(
                output_path,
                audio_tensor,
                sample_rate,
                encoding="PCM_S",
                bits_per_sample=bit_depth
            )
            
            logger.info(f"High-quality audio saved: {output_path} ({sample_rate}Hz, {bit_depth}-bit)")
            
        except Exception as e:
            logger.error(f"Failed to save high-quality audio: {e}")
            raise

# Global audio enhancer instance
audio_enhancer = AudioEnhancer()
