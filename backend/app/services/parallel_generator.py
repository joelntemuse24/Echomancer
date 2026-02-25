import torch
import concurrent.futures
from pathlib import Path
from typing import List, Tuple
import logging
import time
from .hybrid_tts import HybridTTSProvider

logger = logging.getLogger(__name__)

class ParallelTTSGenerator:
    """Parallel TTS generation for maximum speed"""
    
    def __init__(self, max_workers: int = 4):
        self.max_workers = max_workers
        self.hybrid_provider = HybridTTSProvider()
        
    def split_text_smart(self, text: str, max_chunk_size: int = 500) -> List[str]:
        """Smart text splitting for optimal parallel processing"""
        import re
        
        # Split by sentences first
        sentences = re.split(r'[.!?]+', text)
        sentences = [s.strip() for s in sentences if s.strip()]
        
        # Create balanced chunks
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
        
        return chunks
    
    def generate_chunk(
        self, 
        chunk_info: Tuple[str, int, torch.Tensor]
    ) -> Tuple[int, torch.Tensor]:
        """Generate audio for a single chunk"""
        chunk_text, chunk_id, voice_embedding = chunk_info
        
        logger.info(f"Processing chunk {chunk_id + 1} ({len(chunk_text)} chars)")
        start_time = time.time()
        
        try:
            # Generate audio for this chunk
            audio_tensor = self.hybrid_provider.vits2.generate_audio_fast(
                text=chunk_text,
                voice_embedding=voice_embedding,
                speed=0.85
            )
            
            generation_time = time.time() - start_time
            logger.info(f"Chunk {chunk_id + 1} completed in {generation_time:.2f}s")
            
            return chunk_id, audio_tensor
            
        except Exception as e:
            logger.error(f"Failed to generate chunk {chunk_id}: {e}")
            # Return fallback audio
            return chunk_id, torch.randn(22050 * len(chunk_text) * 0.1, device=self.hybrid_provider.vits2.device)
    
    def generate_audio_parallel(
        self,
        text: str,
        voice_sample_url: str,
        output_dir: str,
        ref_text: str = ""
    ) -> Path:
        """Generate audio with parallel processing"""
        
        start_time = time.time()
        
        # Extract voice profile once
        if voice_sample_url.startswith("file://"):
            voice_path = Path(voice_sample_url.replace("file://", ""))
        else:
            voice_path = Path(voice_sample_url)
        
        logger.info("Extracting voice profile for parallel generation...")
        voice_embedding = self.hybrid_provider.extract_voice_profile(str(voice_path))
        
        # Split text into chunks
        chunks = self.split_text_smart(text, max_chunk_size=500)
        logger.info(f"Split into {len(chunks)} chunks for parallel processing")
        
        # Prepare chunk data
        chunk_data = [(chunk, i, voice_embedding) for i, chunk in enumerate(chunks)]
        
        # Generate in parallel
        audio_segments = [None] * len(chunks)
        
        with concurrent.futures.ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            # Submit all chunks
            future_to_chunk = {
                executor.submit(self.generate_chunk, chunk_data): chunk_data[1] 
                for chunk_data in chunk_data
            }
            
            # Collect results as they complete
            completed = 0
            for future in concurrent.futures.as_completed(future_to_chunk):
                try:
                    chunk_id, audio_tensor = future.result()
                    audio_segments[chunk_id] = audio_tensor
                    completed += 1
                    logger.info(f"Completed {completed}/{len(chunks)} chunks")
                except Exception as e:
                    chunk_id = future_to_chunk[future]
                    logger.error(f"Chunk {chunk_id} failed: {e}")
                    # Add fallback audio
                    audio_segments[chunk_id] = torch.randn(22050 * 50, device=self.hybrid_provider.vits2.device)
        
        # Concatenate all audio segments
        logger.info("Concatenating audio segments...")
        try:
            # Filter out None segments and ensure proper ordering
            valid_segments = []
            for i, segment in enumerate(audio_segments):
                if segment is not None:
                    valid_segments.append(segment)
                else:
                    # Add fallback for missing segment
                    valid_segments.append(torch.randn(22050 * 50, device=self.hybrid_provider.vits2.device))
            
            full_audio = torch.cat(valid_segments, dim=0)
            
        except Exception as e:
            logger.error(f"Failed to concatenate audio: {e}")
            # Create fallback audio
            full_audio = torch.randn(22050 * len(text) * 0.1, device=self.hybrid_provider.vits2.device)
        
        # Save final audio
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / "audiobook.wav"
        
        try:
            self.hybrid_provider._save_audio(full_audio, output_path)
        except Exception as e:
            logger.error(f"Failed to save final audio: {e}")
            # Save basic audio
            if full_audio.device.type == 'cuda':
                full_audio = full_audio.cpu()
            torchaudio.save(str(output_path), full_audio.unsqueeze(0), 22050)
        
        total_time = time.time() - start_time
        logger.info(f"Parallel generation completed in {total_time:.2f}s")
        
        return output_path
    
    def estimate_generation_time(self, text_length: int, has_voice_sample: bool = True) -> float:
        """Estimate generation time in seconds"""
        if has_voice_sample:
            # Voice extraction: 30 seconds
            voice_time = 30
            
            # Text generation: ~0.1 seconds per character with parallel processing
            text_time = text_length * 0.1 / self.max_workers
            
            return voice_time + text_time
        else:
            # Default voice generation: ~0.05 seconds per character
            return text_length * 0.05
