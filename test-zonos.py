#!/usr/bin/env python3
"""
Test script for Zonos TTS deployment.
Quick validation that your Zonos server is working correctly.
"""

import os
import sys
import base64
import argparse
from pathlib import Path

try:
    import requests
except ImportError:
    print("Installing requests...")
    os.system("pip install requests -q")
    import requests


def test_health(url: str) -> bool:
    """Test health endpoint."""
    print("\n🩺 Testing health endpoint...")
    try:
        response = requests.get(f"{url}/health", timeout=10)
        if response.status_code == 200:
            data = response.json()
            print(f"  ✓ Server healthy: {data}")
            return True
        else:
            print(f"  ✗ Health check failed: {response.status_code}")
            return False
    except Exception as e:
        print(f"  ✗ Health check error: {e}")
        return False


def test_generation(url: str, voice_path: str, text: str = "Hello, this is a test of the Zonos text to speech system.") -> bool:
    """Test audio generation."""
    print(f"\n🎙️ Testing audio generation...")
    print(f"  Voice sample: {voice_path}")
    print(f"  Text: '{text[:50]}...' ({len(text)} chars)")
    
    # Load voice sample
    try:
        with open(voice_path, "rb") as f:
            voice_bytes = f.read()
        voice_b64 = base64.b64encode(voice_bytes).decode("utf-8")
        print(f"  Voice size: {len(voice_bytes)} bytes ({len(voice_b64)} base64)")
    except Exception as e:
        print(f"  ✗ Failed to load voice: {e}")
        return False
    
    # Make request
    print("  Sending request...")
    try:
        response = requests.post(
            url,
            json={
                "text": text,
                "reference_audio_base64": voice_b64,
                "format": "mp3",
                "start_time": 0,
                "end_time": 15,
            },
            timeout=300,  # 5 minutes for generation
        )
        
        if response.status_code != 200:
            print(f"  ✗ Request failed: {response.status_code}")
            print(f"  Response: {response.text[:500]}")
            return False
        
        data = response.json()
        
        if "error" in data:
            print(f"  ✗ Generation error: {data['error']}")
            return False
        
        # Save output
        audio_bytes = base64.b64decode(data["audio_base64"])
        output_path = "zonos_test_output.mp3"
        
        with open(output_path, "wb") as f:
            f.write(audio_bytes)
        
        print(f"  ✓ Generated audio: {len(audio_bytes)} bytes")
        print(f"  ✓ Duration: {data.get('duration_seconds', 'unknown')}s")
        print(f"  ✓ Saved to: {output_path}")
        
        return True
        
    except Exception as e:
        print(f"  ✗ Request error: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(description="Test Zonos TTS deployment")
    parser.add_argument("--url", help="Zonos deployment URL")
    parser.add_argument("--voice", help="Path to voice sample audio file")
    parser.add_argument("--text", default="Hello, this is a test of the Zonos text to speech system.", 
                       help="Text to synthesize")
    
    args = parser.parse_args()
    
    # Get URL from environment or args
    url = args.url or os.environ.get("MODAL_TTS_URL")
    if not url:
        print("❌ Error: No URL provided")
        print("Usage: python test-zonos.py --url https://your-url.modal.run --voice sample.mp3")
        print("Or set MODAL_TTS_URL environment variable")
        sys.exit(1)
    
    print("╔═══════════════════════════════════════════════════════════╗")
    print("║           Zonos TTS Deployment Test                       ║")
    print("╚═══════════════════════════════════════════════════════════╝")
    print(f"\nURL: {url}")
    
    # Test health
    health_ok = test_health(url)
    
    # Test generation if voice provided
    gen_ok = False
    if args.voice:
        gen_ok = test_generation(url, args.voice, args.text)
    else:
        print("\n⚠️ No voice sample provided, skipping generation test")
        print("   To test generation: python test-zonos.py --voice sample.mp3")
    
    # Summary
    print("\n═══════════════════════════════════════════════════════════")
    if health_ok and (not args.voice or gen_ok):
        print("✅ All tests passed! Zonos is working correctly.")
        sys.exit(0)
    elif health_ok:
        print("⚠️ Health check passed but generation failed")
        sys.exit(1)
    else:
        print("❌ Health check failed - server may still be starting up")
        print("   Wait 1-2 minutes and try again")
        sys.exit(1)


if __name__ == "__main__":
    main()
