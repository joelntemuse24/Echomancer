# GPU Setup Guide for CosyVoice 2.0

## Current Status
You're currently running on CPU only. To use your rented GPU resources, follow these steps:

## Option 1: Connect to Your GPU Instance (Recommended)
If you're renting GPU resources from a cloud provider:

### For AWS/GCP/Azure:
1. SSH into your GPU instance:
   ```bash
   ssh -i your-key.pem user@your-gpu-instance-ip
   ```

2. Clone and run the project on the GPU instance:
   ```bash
   git clone <your-repo>
   cd Echomancer
   python -m venv venv
   source venv/bin/activate  # On Linux
   pip install -r requirements.txt
   pip install git+https://github.com/FunAudioLLM/CosyVoice.git
   ```

### For RunPod/Paperspace/Lambda Labs:
1. Use their web interface to access the Jupyter notebook or terminal
2. Upload/clone your project
3. Install dependencies in their environment

## Option 2: Install CUDA on Your Current Machine
If you have an NVIDIA GPU locally:

1. **Install NVIDIA drivers**: https://www.nvidia.com/drivers
2. **Install CUDA Toolkit**: https://developer.nvidia.com/cuda-downloads
3. **Reinstall PyTorch with CUDA**:
   ```bash
   pip uninstall torch torchvision torchaudio
   pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
   ```

## Option 3: Use Google Colab (Free GPU)
1. Upload your project to Google Drive
2. Create a new Colab notebook
3. Mount Google Drive and run from there

## Verification
After setup, verify GPU is available:
```python
import torch
print(f"CUDA available: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"GPU: {torch.cuda.get_device_name(0)}")
    print(f"GPU Memory: {torch.cuda.get_device_properties(0).total_mem / 1e9:.1f} GB")
```

## Performance Expectations
- **CPU**: ~10-30 seconds per 100 characters
- **GPU (RTX 3080+)**: ~1-3 seconds per 100 characters
- **GPU (A100/V100)**: ~0.5-1 second per 100 characters

## Recommended GPU Specs
- **Minimum**: RTX 3060 (12GB VRAM)
- **Recommended**: RTX 4090 (24GB VRAM) or A100 (40GB VRAM)
- **Cloud**: AWS p3.2xlarge, GCP a2-highgpu, or RunPod A100

## Cost Optimization
- Use spot instances for 70-90% cost savings
- Stop instances when not in use
- Consider smaller GPUs for testing (T4, RTX 4000)
