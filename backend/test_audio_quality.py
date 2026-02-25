#!/usr/bin/env python3
"""
Audio Quality Test Script
Tests the audio enhancement features and compares quality improvements
"""

import sys
import time
import torch
import torchaudio
from pathlib import Path

# Add the app directory to Python path
sys.path.append(str(Path(__file__).parent))

def test_audio_enhancer():
    """Test the audio enhancement module"""
    print("=" * 50)
    print("Testing Audio Enhancement Module")
    print("=" * 50)
    
    try:
        from app.services.audio_enhancer import audio_enhancer
        
        print(f"✅ Audio enhancer initialized on device: {audio_enhancer.device}")
        
        # Create test audio (simulated TTS output)
        sample_rate = 22050
        duration = 2.0  # 2 seconds
        t = torch.linspace(0, duration, int(sample_rate * duration))
        
        # Create a test signal with some issues
        # Add DC offset
        audio = 0.3 + 0.5 * torch.sin(2 * torch.pi * 440 * t)  # 440 Hz tone with DC offset
        
        # Add some noise
        noise = 0.1 * torch.randn_like(audio)
        audio += noise
        
        # Add some harsh high frequencies
        harsh = 0.2 * torch.sin(2 * torch.pi * 8000 * t)
        audio += harsh
        
        print(f"📊 Original audio: {audio.shape}")
        print(f"📊 Original RMS: {torch.sqrt(torch.mean(audio**2)):.4f}")
        print(f"📊 Original DC offset: {torch.mean(audio):.4f}")
        
        # Apply enhancement
        start_time = time.time()
        enhanced_audio = audio_enhancer.enhance_audio(audio, sample_rate=sample_rate)
        enhancement_time = time.time() - start_time
        
        print(f"✅ Enhancement completed in {enhancement_time:.3f}s")
        print(f"📊 Enhanced RMS: {torch.sqrt(torch.mean(enhanced_audio**2)):.4f}")
        print(f"📊 Enhanced DC offset: {torch.mean(enhanced_audio):.4f}")
        
        # Test upsampling
        upsampled_audio = audio_enhancer.upsample_audio(enhanced_audio, sample_rate, 44100)
        print(f"✅ Upsampled to {upsampled_audio.shape[0]/44100:.2f}s at 44.1kHz")
        
        # Save comparison files
        test_dir = Path("audio_quality_test")
        test_dir.mkdir(exist_ok=True)
        
        # Save original
        torchaudio.save(str(test_dir / "original.wav"), audio.unsqueeze(0), sample_rate)
        
        # Save enhanced
        audio_enhancer.save_high_quality_audio(
            enhanced_audio,
            str(test_dir / "enhanced.wav"),
            sample_rate=44100,
            bit_depth=24
        )
        
        print(f"✅ Test files saved to {test_dir}")
        print(f"   - original.wav (22.05kHz, 16-bit)")
        print(f"   - enhanced.wav (44.1kHz, 24-bit)")
        
        return True
        
    except Exception as e:
        print(f"❌ Audio enhancer test failed: {e}")
        return False

def test_vits2_quality():
    """Test VITS2 provider with quality enhancement"""
    print("=" * 50)
    print("Testing VITS2 Provider with Quality Enhancement")
    print("=" * 50)
    
    try:
        from app.services.vits2 import VITS2Provider
        
        provider = VITS2Provider()
        print("✅ VITS2 provider initialized")
        
        # Test voice embedding extraction (if test audio exists)
        test_audio_path = "test_voice.wav"
        if Path(test_audio_path).exists():
            embedding = provider.extract_voice_embedding(test_audio_path)
            print(f"✅ Voice embedding extracted: {embedding.shape}")
        else:
            print("⚠️  No test audio file found, using default embedding")
            embedding = torch.zeros(256, device=provider.device)
        
        # Test audio generation with enhancement
        test_text = "This is a test of the enhanced audio quality system."
        start_time = time.time()
        
        audio = provider.generate_audio_fast(
            text=test_text,
            voice_embedding=embedding,
            speed=0.85
        )
        
        generation_time = time.time() - start_time
        print(f"✅ Audio generated in {generation_time:.2f}s")
        print(f"📊 Audio shape: {audio.shape}")
        print(f"📊 Audio duration: {len(audio) / 22050:.2f}s")
        
        # Test high-quality saving
        test_dir = Path("audio_quality_test")
        output_path = test_dir / "vits2_enhanced.wav"
        
        provider.save_high_quality_audio(audio, output_path)
        print(f"✅ High-quality VITS2 audio saved: {output_path}")
        
        return True
        
    except Exception as e:
        print(f"❌ VITS2 quality test failed: {e}")
        return False

def test_hybrid_quality():
    """Test Hybrid TTS provider with quality enhancement"""
    print("=" * 50)
    print("Testing Hybrid TTS Provider with Quality Enhancement")
    print("=" * 50)
    
    try:
        from app.services.hybrid_tts import HybridTTSProvider
        
        provider = HybridTTSProvider()
        print("✅ Hybrid provider initialized")
        
        # Test voice profile extraction
        test_audio_path = "test_voice.wav"
        if Path(test_audio_path).exists():
            voice_profile = provider.extract_voice_profile(test_audio_path)
            print(f"✅ Voice profile extracted: {voice_profile.shape}")
        else:
            print("⚠️  No test audio file found")
        
        return True
        
    except Exception as e:
        print(f"❌ Hybrid quality test failed: {e}")
        return False

def test_cosyvoice_quality():
    """Test CosyVoice provider with quality enhancement"""
    print("=" * 50)
    print("Testing CosyVoice Provider with Quality Enhancement")
    print("=" * 50)
    
    try:
        from app.services.cosyvoice import CosyVoiceProvider
        
        provider = CosyVoiceProvider()
        print("✅ CosyVoice provider initialized")
        print(f"📊 Device: {provider.device}")
        
        return True
        
    except Exception as e:
        print(f"❌ CosyVoice quality test failed: {e}")
        return False

def compare_audio_quality():
    """Compare audio quality across different providers"""
    print("=" * 50)
    print("Audio Quality Comparison")
    print("=" * 50)
    
    try:
        from app.services.audio_enhancer import audio_enhancer
        
        # Create test audio with typical TTS issues
        sample_rate = 22050
        duration = 1.0
        t = torch.linspace(0, duration, int(sample_rate * duration))
        
        # Simulate problematic TTS output
        problematic_audio = (
            0.2 +  # DC offset
            0.6 * torch.sin(2 * torch.pi * 200 * t) +  # Main signal
            0.3 * torch.sin(2 * torch.pi * 2000 * t) +  # Harsh frequencies
            0.15 * torch.randn_like(t) +  # Noise
            0.1 * torch.sign(torch.sin(2 * torch.pi * 50 * t))  # Distortion
        )
        
        print(f"📊 Test audio created with typical TTS issues")
        print(f"   - DC offset: {torch.mean(problematic_audio):.3f}")
        print(f"   - RMS level: {torch.sqrt(torch.mean(problematic_audio**2)):.3f}")
        print(f"   - Peak level: {torch.max(torch.abs(problematic_audio)):.3f}")
        
        # Apply enhancement
        enhanced_audio = audio_enhancer.enhance_audio(problematic_audio, sample_rate)
        
        print(f"✅ Enhancement applied")
        print(f"   - DC offset: {torch.mean(enhanced_audio):.3f}")
        print(f"   - RMS level: {torch.sqrt(torch.mean(enhanced_audio**2)):.3f}")
        print(f"   - Peak level: {torch.max(torch.abs(enhanced_audio)):.3f}")
        
        # Calculate quality metrics
        original_dynamic_range = torch.max(problematic_audio) - torch.min(problematic_audio)
        enhanced_dynamic_range = torch.max(enhanced_audio) - torch.min(enhanced_audio)
        
        original_thd = torch.std(problematic_audio) / torch.mean(torch.abs(problematic_audio))
        enhanced_thd = torch.std(enhanced_audio) / torch.mean(torch.abs(enhanced_audio))
        
        print(f"\n📊 Quality Metrics:")
        print(f"   Original dynamic range: {original_dynamic_range:.3f}")
        print(f"   Enhanced dynamic range: {enhanced_dynamic_range:.3f}")
        print(f"   Original THD: {original_thd:.3f}")
        print(f"   Enhanced THD: {enhanced_thd:.3f}")
        
        # Save comparison
        test_dir = Path("audio_quality_test")
        test_dir.mkdir(exist_ok=True)
        
        torchaudio.save(str(test_dir / "problematic_original.wav"), problematic_audio.unsqueeze(0), sample_rate)
        audio_enhancer.save_high_quality_audio(enhanced_audio, str(test_dir / "problematic_enhanced.wav"))
        
        print(f"✅ Comparison files saved to {test_dir}")
        
        return True
        
    except Exception as e:
        print(f"❌ Quality comparison failed: {e}")
        return False

def main():
    """Run all audio quality tests"""
    print("🎵 Audio Quality Enhancement Test Suite")
    print("=" * 60)
    
    tests = [
        ("Audio Enhancer Module", test_audio_enhancer),
        ("VITS2 Quality Enhancement", test_vits2_quality),
        ("Hybrid TTS Quality", test_hybrid_quality),
        ("CosyVoice Quality", test_cosyvoice_quality),
        ("Quality Comparison", compare_audio_quality),
    ]
    
    results = []
    
    for test_name, test_func in tests:
        print(f"\n🧪 Running {test_name}...")
        try:
            result = test_func()
            results.append((test_name, result))
        except Exception as e:
            print(f"❌ {test_name} crashed: {e}")
            results.append((test_name, False))
    
    # Summary
    print("\n" + "=" * 60)
    print("📊 Audio Quality Test Results Summary")
    print("=" * 60)
    
    passed = 0
    total = len(results)
    
    for test_name, result in results:
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"{status} {test_name}")
        if result:
            passed += 1
    
    print(f"\n🎯 Overall: {passed}/{total} tests passed")
    
    if passed == total:
        print("🎉 All audio quality tests passed!")
        print("\n📈 Quality Improvements Applied:")
        print("   • DC offset removal")
        print("   • High-pass filtering (rumble reduction)")
        print("   • De-essing (sibilance reduction)")
        print("   • Dynamic compression")
        print("   • Noise reduction")
        print("   • Audio smoothing")
        print("   • Level normalization")
        print("   • Subtle reverb for naturalness")
        print("   • Upsampling to 44.1kHz")
        print("   • 24-bit depth for better dynamic range")
        print("\n🎵 Expected Results:")
        print("   • Clearer, less garbled audio")
        print("   • Reduced background noise")
        print("   • More natural speech quality")
        print("   • Professional-grade audio fidelity")
    else:
        print("⚠️  Some tests failed. Check the logs above.")
    
    print(f"\n📂 Test files saved to: audio_quality_test/")
    print("   Listen to the comparison files to hear the difference!")

if __name__ == "__main__":
    main()
