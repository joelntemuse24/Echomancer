#!/bin/bash
# Fish Speech V1.5 Setup Script for Vast.ai
# Run this after SSH'ing into your Vast.ai instance
#
# Usage: Copy this entire script and paste into terminal, OR:
#   curl -sSL <your-gist-url> | bash

set -e  # Exit on error

echo "=== Step 1: Installing system dependencies ==="
apt-get update
apt-get install -y git ffmpeg portaudio19-dev curl

echo "=== Step 2: Cloning Fish Speech ==="
cd /workspace
if [ ! -d "fish-speech" ]; then
    git clone https://github.com/fishaudio/fish-speech.git
fi
cd fish-speech

echo "=== Step 3: Installing Python dependencies ==="
pip install -e .
pip install fastapi uvicorn httpx pyaudio

echo "=== Step 4: Downloading model (this takes 2-5 minutes) ==="
python -c "from huggingface_hub import snapshot_download; snapshot_download('fishaudio/fish-speech-1.5', local_dir='checkpoints/fish-speech-1.5')"

echo "=== Step 5: Verifying model files ==="
ls -la checkpoints/fish-speech-1.5/

echo ""
echo "=========================================="
echo "  SETUP COMPLETE!"
echo "=========================================="
echo ""
echo "Your public IP:"
curl -s ifconfig.me || hostname -I | awk '{print $1}'
echo ""
echo ""
echo "To start the API server, run:"
echo "  cd /workspace/fish-speech"
echo "  python /workspace/fish-speech-server.py"
echo ""
echo "Or to start in background:"
echo "  nohup python /workspace/fish-speech-server.py > server.log 2>&1 &"
echo ""
