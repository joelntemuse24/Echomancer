#!/bin/bash
# ============================================
# TensorDock RTX 4090 Setup Script for Echomancer
# ============================================
# Run this after SSH-ing into your TensorDock instance:
#   ssh -p <port> user@<ip>
#   bash tensordock-setup.sh
#
# Prerequisites: Ubuntu 22.04 with NVIDIA drivers (TensorDock provides this)
# GPU: RTX 4090 24GB VRAM (~$0.35/hr)
# ============================================

set -e  # Exit on any error

echo "=========================================="
echo " Echomancer TensorDock Setup"
echo "=========================================="

# 1. System dependencies
echo "[1/6] Installing system dependencies..."
sudo apt-get update -qq
sudo apt-get install -y -qq python3.11 python3.11-venv python3-pip ffmpeg git

# 2. Create project directory and venv
echo "[2/6] Setting up Python virtual environment..."
mkdir -p /workspace/echomancer
cd /workspace/echomancer

python3.11 -m venv venv
source venv/bin/activate

# 3. Install PyTorch with CUDA support
echo "[3/6] Installing PyTorch with CUDA..."
pip install --upgrade pip
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121

# 4. Install Chatterbox TTS
echo "[4/6] Installing Chatterbox TTS..."
pip install chatterbox-tts

# 5. Clone repo and install app dependencies
echo "[5/6] Cloning Echomancer and installing dependencies..."
if [ -d "app" ]; then
    echo "App directory exists, pulling latest..."
    cd app && git pull && cd ..
else
    git clone https://github.com/joelntemuse24/Echomancer.git app
fi

cd app/backend
pip install -r requirements.txt

# 6. Create .env if it doesn't exist
if [ ! -f .env ]; then
    echo "[6/6] Creating .env configuration..."
    cat > .env << 'EOF'
# Echomancer TensorDock Configuration
ENVIRONMENT=production
PORT=8000
SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")

# TTS Provider - Chatterbox on local GPU
TTS_PROVIDER=chatterbox
CHATTERBOX_DEVICE=cuda
CHATTERBOX_EXAGGERATION=0.5
CHATTERBOX_CFG_WEIGHT=0.5

# Replicate fallback (optional)
# REPLICATE_API_TOKEN=r8_your_token_here
EOF
    echo ".env created. Edit it to add any API keys you need."
else
    echo "[6/6] .env already exists, skipping..."
fi

# Verify GPU
echo ""
echo "=========================================="
echo " Setup Complete! Verifying GPU..."
echo "=========================================="
python3 -c "
import torch
print(f'PyTorch: {torch.__version__}')
print(f'CUDA available: {torch.cuda.is_available()}')
if torch.cuda.is_available():
    print(f'GPU: {torch.cuda.get_device_name(0)}')
    print(f'VRAM: {torch.cuda.get_device_properties(0).total_mem / 1e9:.1f} GB')
"

echo ""
echo "=========================================="
echo " Ready to run!"
echo "=========================================="
echo ""
echo "Start the server:"
echo "  cd /workspace/echomancer/app/backend"
echo "  source /workspace/echomancer/venv/bin/activate"
echo "  uvicorn app.main:app --host 0.0.0.0 --port 8000"
echo ""
echo "Then access from browser:"
echo "  http://<your-tensordock-ip>:8000/web/simple/"
echo ""
echo "Test TTS config:"
echo "  curl http://localhost:8000/web/simple/test"
echo ""
echo "NOTE: First request will take ~30s to load the Chatterbox model into GPU memory."
echo "      Subsequent requests will be much faster."
