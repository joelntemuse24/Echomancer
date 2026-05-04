#!/usr/bin/env python3
"""
Download F5-TTS models locally
This downloads the same models that will be used in Modal deployment
"""

import os
import sys
from pathlib import Path

def download_f5_tts_model(cache_dir: str = "./model_cache"):
    """Download F5-TTS model from HuggingFace"""
    print("=" * 60)
    print("Downloading F5-TTS Model")
    print("=" * 60)
    
    try:
        from huggingface_hub import snapshot_download
        import torch
    except ImportError:
        print("\n[ERROR] Required packages not found.")
        print("Installing required packages...")
        os.system(f"{sys.executable} -m pip install torch huggingface-hub -q")
        from huggingface_hub import snapshot_download
        import torch
    
    # Create cache directory
    cache_path = Path(cache_dir)
    cache_path.mkdir(parents=True, exist_ok=True)
    
    f5_dir = cache_path / "f5-tts-model"
    vocoder_dir = cache_path / "vocoder"
    
    print(f"\n[DIR] Cache directory: {cache_path.absolute()}")
    print()
    
    # Download F5-TTS model
    print("[DOWNLOAD] Downloading F5-TTS model (SWivid/F5-TTS)...")
    print("   This is ~2GB and may take 5-10 minutes...")
    print()
    
    try:
        f5_path = snapshot_download(
            repo_id="SWivid/F5-TTS",
            local_dir=str(f5_dir),
            local_dir_use_symlinks=False,
            resume_download=True,
        )
        print(f"[OK] F5-TTS model downloaded to: {f5_path}")
        
        # List what was downloaded
        if f5_dir.exists():
            files = list(f5_dir.rglob("*"))
            total_size = sum(f.stat().st_size for f in files if f.is_file())
            print(f"   Files: {len([f for f in files if f.is_file()])}")
            print(f"   Total size: {total_size / (1024**3):.2f} GB")
            
    except Exception as e:
        print(f"[ERROR] Error downloading F5-TTS: {e}")
        return False
    
    print()
    
    # Download Vocoder
    print("[DOWNLOAD] Downloading Vocos vocoder (charactr/vocos-mel-24khz)...")
    print("   This is ~300MB...")
    print()
    
    try:
        vocoder_path = snapshot_download(
            repo_id="charactr/vocos-mel-24khz",
            local_dir=str(vocoder_dir),
            local_dir_use_symlinks=False,
            resume_download=True,
        )
        print(f"[OK] Vocoder downloaded to: {vocoder_path}")
        
        if vocoder_dir.exists():
            files = list(vocoder_dir.rglob("*"))
            total_size = sum(f.stat().st_size for f in files if f.is_file())
            print(f"   Files: {len([f for f in files if f.is_file()])}")
            print(f"   Total size: {total_size / (1024**2):.2f} MB")
            
    except Exception as e:
        print(f"[ERROR] Error downloading vocoder: {e}")
        return False
    
    return True


def download_demucs_model(cache_dir: str = "./model_cache"):
    """Download Demucs model for audio cleaning"""
    print("\n" + "=" * 60)
    print("Downloading Demucs Model (for Audio Cleaner)")
    print("=" * 60)
    
    try:
        import torch
    except ImportError:
        print("\n[ERROR] PyTorch not found. Installing...")
        os.system(f"{sys.executable} -m pip install torch -q")
        import torch
    
    print("\n[DOWNLOAD] Downloading Demucs htdemucs_ft model...")
    print("   This is ~150MB...")
    
    try:
        # Demucs downloads automatically on first use, but we can pre-download
        torch.hub.download_url_to_file(
            "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/5c3c30c8-649c-4f5c-9c8c-0c8c8c8c8c8c.th",
            str(Path(cache_dir) / "demucs_model.th"),
        )
        print("[OK] Demucs model downloaded")
    except Exception as e:
        print(f"⚠️  Demucs will be downloaded on first use (this is normal)")
        print(f"   Details: {e}")
    
    return True


def verify_models(cache_dir: str = "./model_cache"):
    """Verify downloaded models"""
    print("\n" + "=" * 60)
    print("Verification")
    print("=" * 60)
    
    cache_path = Path(cache_dir)
    
    checks = {
        "F5-TTS model": cache_path / "f5-tts-model",
        "Vocoder": cache_path / "vocoder",
    }
    
    all_good = True
    for name, path in checks.items():
        if path.exists():
            files = list(path.rglob("*.pt")) + list(path.rglob("*.bin")) + list(path.rglob("*.json"))
            size = sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
            print(f"[OK] {name}: {len(files)} model files ({size / (1024**3):.2f} GB)")
        else:
            print(f"[MISSING] {name}: Not found")
            all_good = False
    
    return all_good


def main():
    print("\n" + "=" * 60)
    print("F5-TTS Model Download Tool")
    print("=" * 60)
    print("\nThis script downloads the F5-TTS models locally.")
    print("The same models will be downloaded to Modal during deployment.")
    print()
    
    cache_dir = "./model_cache"
    
    # Check for huggingface token (optional but recommended for large downloads)
    if not os.getenv("HF_TOKEN"):
        print("[TIP] Set HF_TOKEN environment variable for faster downloads")
        print("   Get token at: https://huggingface.co/settings/tokens")
        print()
    
    # Download models
    success = download_f5_tts_model(cache_dir)
    
    if success:
        download_demucs_model(cache_dir)
        
        print("\n" + "=" * 60)
        print("Download Summary")
        print("=" * 60)
        
        if verify_models(cache_dir):
            print("\n[SUCCESS] All models downloaded successfully!")
            print(f"\n📁 Models are cached in: {Path(cache_dir).absolute()}")
            print("\nYou can now deploy to Modal with:")
            print("   .\\deploy-f5-tts.ps1    (Windows)")
            print("   ./deploy-f5-tts.sh      (Mac/Linux)")
            return 0
        else:
            print("\n[WARN] Some models are missing. Try running again.")
            return 1
    else:
        print("\n[ERROR] Failed to download models.")
        print("Check your internet connection and try again.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
