# Zonos TTS Deployment Issues - Technical Summary for Gemini

## Project Context
Building an audiobook generator (Echomancer) that converts PDFs to audiobooks with AI voice cloning. Currently using Modal (serverless GPU) for TTS inference.

## Current Working Setup
- **Frontend**: Next.js 16 + TypeScript + Supabase
- **TTS Model**: F5-TTS on Modal (L4 GPU)
- **Deployment**: Works but quality is mediocre
- **Chunk Size**: 1500 characters per request
- **Voice Sample Limit**: 15 seconds max

## The Goal
Migrate from F5-TTS to **Zonos** (Zyphra/Zonos-v0.1-transformer) because:
1. Superior voice cloning quality
2. Supports 30-second voice samples (vs 15s)
3. Better prosody/consistency for long-form audiobooks
4. Lower cost (runs on L4 vs A10G)
5. Native support for longer text chunks

## The Problem
**Zonos deployment on Modal consistently fails with import errors.**

### Error Timeline

#### Attempt 1: PyPI Installation
```python
.pip_install("zonos")  # Package doesn't exist on PyPI
```
**Error**: `ModuleNotFoundError: No module named 'zonos'`

#### Attempt 2: GitHub Direct Install
```python
.pip_install("git+https://github.com/Zyphra/Zonos.git")
```
**Error**: `ModuleNotFoundError: No module named 'zonos'`

#### Attempt 3: Clone + Editable Install with sys.path
```python
.run_commands(
    "cd /root && git clone --depth 1 https://github.com/Zyphra/Zonos.git",
    "cd /root/Zonos && pip install -e . --no-deps",
)
# In Python:
import sys
sys.path.insert(0, '/root/Zonos')
from zonos.model import Zonos
```
**Error**: `ModuleNotFoundError: No module named 'zonos.backbone'`

#### Attempt 4: Clone + Full pip install
```python
.run_commands(
    "cd /root && git clone --depth 1 https://github.com/Zyphra/Zonos.git",
    "cd /root/Zonos && pip install -e .",
)
```
**Error**: `ModuleNotFoundError: No module named 'zonos.backbone'`

### Current Modal Dashboard Status
- App deploys successfully (image builds)
- Containers enter "crash-looping" state
- All containers fail within 10-30 seconds of startup
- Health endpoint never becomes available
- 10+ errors shown in Modal dashboard

## What We've Verified
1. **Git clone works** - Repo is cloned to `/root/Zonos`
2. **Dependencies install** - torch, transformers, phonemizer, gradio all install successfully
3. **Container can access files** - `/root/Zonos` exists and contains model.py
4. **Python path is set** - `sys.path.insert(0, '/root/Zonos')` is called before import
5. **Model downloads** - Zonos model weights download from HuggingFace successfully

## Suspected Root Causes

### 1. Package Discovery Issues
Zonos repository structure:
```
Zonos/
├── zonos/
│   ├── __init__.py
│   ├── model.py
│   ├── backbone/
│   │   ├── __init__.py
│   │   └── ...
│   └── ...
├── setup.py / pyproject.toml
└── ...
```

The `backbone` submodule may not be properly discovered during editable install in Modal's containerized environment.

### 2. Cython/Build Extensions
Zonos has C++ extensions that need compilation:
- `sudachipy` (Japanese tokenizer)
- `phonemizer` backend (espeak)
- Custom CUDA kernels may not compile properly

### 3. Modal Container Limitations
- File system permissions in `/root`
- PYTHONPATH handling differs from standard environments
- Editable installs (`pip install -e`) may not work as expected
- Container image layers may not preserve git repo structure

### 4. Missing System Dependencies
Zonos requires:
- `espeak` (for phonemizer) - INSTALLED
- `espeak-data` - INSTALLED  
- C++ compiler - INSTALLED (build-essential)
- Japanese dictionary data (SudachiDict) - INSTALLED

But there may be hidden dependencies.

### 5. Import Chain Failure
The error occurs at:
```python
# zonos/model.py line 11
from zonos.backbone import BACKBONES
```

Even though `sys.path` includes `/root/Zonos`, Python cannot find `zonos.backbone`.

## What Works (Reference)
**F5-TTS deploys perfectly with this pattern:**
```python
image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg", "libsndfile1")
    .pip_install("f5-tts", "torch", "torchaudio", "soundfile", "numpy")
)

@app.cls(gpu="L4", image=image)
class F5TTSServer:
    @modal.enter()
    def load_model(self):
        from f5_tts.api import F5TTS
        self.tts = F5TTS(device="cuda")
```

F5-TTS is a standard PyPI package with clean imports.

## What We Need
A working Modal deployment of Zonos that:
1. Successfully imports `from zonos.model import Zonos`
2. Can call `Zonos.from_pretrained("Zyphra/Zonos-v0.1-transformer")`
3. Has a FastAPI endpoint that accepts `{text, reference_audio_base64}`
4. Returns base64-encoded MP3 audio

## Questions for Gemini
1. Why does `sys.path.insert(0, '/root/Zonos')` not resolve the import?
2. Is there a better way to install Zonos in a Modal container?
3. Could we use `PYTHONPATH` environment variable instead?
4. Should we try installing to a different directory (not `/root`)?
5. Is there a way to verify the package structure is correct in the built image?
6. Could we create a wrapper that properly exposes the Zonos modules?
7. Alternative: Can we run Zonos via subprocess or HTTP server within the container?

## Environment Details
- **Modal Image**: `modal.Image.debian_slim(python_version="3.10")`
- **GPU**: L4 (also tried A10G)
- **Python**: 3.10
- **Modal Version**: Latest (deployed March 2026)
- **Zonos Commit**: `bc40d98e1e1ab54fc65c483be127a90e3c7c0645` (latest main)

## Files
Current deployment file: `modal/zonos_server.py` (attached)

---

**Please provide a solution that makes Zonos import successfully in a Modal container.**
