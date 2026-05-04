#!/usr/bin/env python3
"""
Test script for F5-TTS Modal deployment
Tests both single and batch generation endpoints
"""

import os
import sys
import base64
import io
import requests
import numpy as np
import soundfile as sf
from pathlib import Path

# Configuration - update these after deployment
MODAL_TTS_URL = os.getenv("MODAL_TTS_URL", "")
MODAL_AUDIO_CLEANER_URL = os.getenv("MODAL_AUDIO_CLEANER_URL", "")

if not MODAL_TTS_URL:
    print("❌ MODAL_TTS_URL not set")
    print("Set it with: $env:MODAL_TTS_URL='your-url' (PowerShell)")
    print("Or: export MODAL_TTS_URL='your-url' (Bash)")
    sys.exit(1)


def create_test_audio(duration=5, sample_rate=24000):
    """Create a test sine wave audio"""
    t = np.linspace(0, duration, int(sample_rate * duration))
    # Create a pleasant tone with slight amplitude envelope
    audio = 0.3 * np.sin(2 * np.pi * 440 * t) * (1 - t/duration)
    
    buffer = io.BytesIO()
    sf.write(buffer, audio, sample_rate, format="WAV")
    buffer.seek(0)
    
    return base64.b64encode(buffer.read()).decode("utf-8")


def test_health():
    """Test health endpoint"""
    print("\n=== Testing Health Endpoint ===")
    
    try:
        # Extract base URL
        base_url = MODAL_TTS_URL.replace("/generate_batch", "")
        response = requests.get(f"{base_url}/health", timeout=30)
        
        if response.status_code == 200:
            print(f"✅ Health check passed: {response.json()}")
            return True
        else:
            print(f"❌ Health check failed: {response.status_code}")
            return False
            
    except Exception as e:
        print(f"❌ Health check error: {e}")
        return False


def test_single_generation():
    """Test single text generation"""
    print("\n=== Testing Single Generation ===")
    
    test_audio = create_test_audio(duration=5)
    
    payload = {
        "text": "Hello, this is a test of the F5-TTS system on Modal.",
        "reference_audio_base64": test_audio,
        "nfe_step": 16,  # Fast for testing
        "speed": 1.0,
    }
    
    try:
        base_url = MODAL_TTS_URL.replace("/generate_batch", "")
        start_time = __import__('time').time()
        
        response = requests.post(
            f"{base_url}/generate",
            json=payload,
            timeout=120
        )
        
        elapsed = __import__('time').time() - start_time
        
        if response.status_code == 200:
            result = response.json()
            
            if result.get("error"):
                print(f"❌ Generation error: {result['error']}")
                return False
            
            audio_data = base64.b64decode(result["audio_base64"])
            duration = result.get("duration_seconds", 0)
            gen_time = result.get("generation_time_seconds", 0)
            
            # Save test output
            output_path = Path("test_output_single.wav")
            output_path.write_bytes(audio_data)
            
            print(f"✅ Single generation successful")
            print(f"   Duration: {duration:.1f}s")
            print(f"   Generation time: {gen_time:.1f}s")
            print(f"   RTF: {gen_time/duration:.2f}")
            print(f"   Output saved to: {output_path}")
            return True
        else:
            print(f"❌ Request failed: {response.status_code}")
            print(f"   Response: {response.text[:500]}")
            return False
            
    except Exception as e:
        print(f"❌ Error: {e}")
        return False


def test_batch_generation():
    """Test batch generation"""
    print("\n=== Testing Batch Generation ===")
    
    test_audio = create_test_audio(duration=5)
    
    texts = [
        "First test sentence for batch generation.",
        "Second test sentence for batch generation.",
        "Third test sentence for batch generation.",
    ]
    
    payload = {
        "texts": texts,
        "reference_audio_base64": test_audio,
        "nfe_step": 16,
        "speed": 1.0,
    }
    
    try:
        start_time = __import__('time').time()
        
        response = requests.post(
            MODAL_TTS_URL,
            json=payload,
            timeout=180
        )
        
        elapsed = __import__('time').time() - start_time
        
        if response.status_code == 200:
            result = response.json()
            
            results = result.get("results", [])
            total_time = result.get("total_time_seconds", 0)
            
            success_count = sum(1 for r in results if not r.get("error"))
            
            print(f"✅ Batch generation successful")
            print(f"   Total time: {total_time:.1f}s")
            print(f"   Successful: {success_count}/{len(texts)}")
            print(f"   Per-section avg: {total_time/len(texts):.1f}s")
            
            # Save outputs
            for i, r in enumerate(results):
                if r.get("audio_base64"):
                    audio_data = base64.b64decode(r["audio_base64"])
                    output_path = Path(f"test_output_batch_{i}.wav")
                    output_path.write_bytes(audio_data)
                    print(f"   Saved: {output_path}")
            
            return success_count == len(texts)
        else:
            print(f"❌ Request failed: {response.status_code}")
            print(f"   Response: {response.text[:500]}")
            return False
            
    except Exception as e:
        print(f"❌ Error: {e}")
        return False


def test_audio_cleaner():
    """Test audio cleaner endpoint"""
    if not MODAL_AUDIO_CLEANER_URL:
        print("\n=== Audio Cleaner Test Skipped (MODAL_AUDIO_CLEANER_URL not set) ===")
        return True
    
    print("\n=== Testing Audio Cleaner ===")
    
    test_audio = create_test_audio(duration=5)
    
    payload = {
        "audio_base64": test_audio,
        "target_sample_rate": 24000,
        "normalize_loudness": True,
        "target_lufs": -16.0,
    }
    
    try:
        start_time = __import__('time').time()
        
        response = requests.post(
            MODAL_AUDIO_CLEANER_URL,
            json=payload,
            timeout=120
        )
        
        elapsed = __import__('time').time() - start_time
        
        if response.status_code == 200:
            result = response.json()
            
            if result.get("error"):
                print(f"❌ Cleaner error: {result['error']}")
                return False
            
            audio_data = base64.b64decode(result["audio_base64"])
            orig_duration = result.get("original_duration", 0)
            proc_duration = result.get("processed_duration", 0)
            
            # Save test output
            output_path = Path("test_output_cleaned.wav")
            output_path.write_bytes(audio_data)
            
            print(f"✅ Audio cleaning successful")
            print(f"   Original duration: {orig_duration:.1f}s")
            print(f"   Processed duration: {proc_duration:.1f}s")
            print(f"   Processing time: {elapsed:.1f}s")
            print(f"   Output saved to: {output_path}")
            return True
        else:
            print(f"❌ Request failed: {response.status_code}")
            print(f"   Response: {response.text[:500]}")
            return False
            
    except Exception as e:
        print(f"❌ Error: {e}")
        return False


def main():
    """Run all tests"""
    print("=" * 60)
    print("F5-TTS Modal Deployment Test")
    print("=" * 60)
    print(f"TTS URL: {MODAL_TTS_URL}")
    print(f"Cleaner URL: {MODAL_AUDIO_CLEANER_URL or 'Not set'}")
    
    results = []
    
    # Run tests
    results.append(("Health", test_health()))
    results.append(("Single Generation", test_single_generation()))
    results.append(("Batch Generation", test_batch_generation()))
    results.append(("Audio Cleaner", test_audio_cleaner()))
    
    # Summary
    print("\n" + "=" * 60)
    print("Test Summary")
    print("=" * 60)
    
    for name, passed in results:
        status = "✅ PASS" if passed else "❌ FAIL"
        print(f"{status}: {name}")
    
    all_passed = all(r[1] for r in results)
    
    print("\n" + "=" * 60)
    if all_passed:
        print("🎉 All tests passed! F5-TTS is ready to use.")
    else:
        print("⚠️ Some tests failed. Check the logs above.")
    print("=" * 60)
    
    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
