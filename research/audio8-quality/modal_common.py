"""Shared Modal plumbing: image, volume, reference/text loading, path helpers.

Every `modal_*.py` script is a thin wrapper around `audio8q.jobs`. Keeping the
Modal surface here means the job bodies can run unmodified on a laptop CPU,
which is how they were debugged before any GPU time was spent.

Volume layout (all under `/vol/audio8-quality/`):

    <run>/metrics.json          the small file to send back
    <run>/wav/*.wav             every take, named {variant}__{text}__s{seed}__{ref}
    <run>/breath_direction.npy  the steering direction (shared by later jobs)
    <run>/decoder_lite.pt       the codec decoder fine-tune (job 3)
    <run>/lora_state.pt         the slow-AR LoRA (job 5)

Volume `audio8-trial-vol` is the one the earlier trial used, so `modal volume ls`
already works. Nothing here touches the `echomancer-s2-clone` app: every app in
this folder is named `audio8q-*`.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import modal

APP_PREFIX = "audio8q"
VOLUME_NAME = "audio8-trial-vol"
VOLUME_ROOT = "/vol/audio8-quality"
MODEL_ID = "Edge0/Audio8-TTS-Realistic-Air"
MODEL_DIR = "/models/air"
REPO_REMOTE = "/work/audio8-quality"
LOCAL_ROOT = Path(__file__).resolve().parent
# L4 first: cheapest card that fits a 0.6B model plus a 337M codec in bf16.
DEFAULT_GPU = ["L4", "A10G"]
TORCH = "torch==2.8.0"
TRANSFORMERS = "transformers==4.57.3"

volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)

_RUNTIME_PIP = [
    TORCH,
    TRANSFORMERS,
    "soundfile",
    "numpy<2",
    "scipy",
    "librosa",
    "safetensors",
    "huggingface_hub[hf_xet]",
    "pyloudnorm",
]

# One image for every GPU job. `hf download` runs at build time, so a cold start
# only pays for the volume mount and model load (~12 s on an L4 in the trial).
gpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libsndfile1", "git")
    .pip_install(*_RUNTIME_PIP)
    .run_commands(
        f"hf download {MODEL_ID} --local-dir {MODEL_DIR}",
        "python -c \"import torch, transformers; print(torch.__version__, transformers.__version__)\"",
    )
    .env({"HF_HOME": "/cache/hf", "TOKENIZERS_PARALLELISM": "false"})
)

# Data prep needs the model too (to encode latents) but no GPU.
cpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libsndfile1", "git")
    .pip_install(*_RUNTIME_PIP)
    .run_commands(f"hf download {MODEL_ID} --local-dir {MODEL_DIR}")
    .env({"TOKENIZERS_PARALLELISM": "false"})
)

# Analysis-only image: no weights, so `modal run modal_eval.py` starts in ~20 s.
eval_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libsndfile1")
    .pip_install(
        "torch==2.8.0",
        "numpy<2",
        "scipy",
        "librosa",
        "soundfile",
        "faster-whisper",
        "jiwer",
        "whisper-normalizer",
        "speechbrain",
    )
    .run_commands(
        "python -c \"from faster_whisper import WhisperModel; "
        "WhisperModel('small.en', device='cpu', compute_type='int8')\"",
        "python -c \"from speechbrain.inference.speaker import EncoderClassifier; "
        "EncoderClassifier.from_hparams('speechbrain/spkrec-ecapa-voxceleb', savedir='/models/ecapa')\"",
    )
)


def with_repo(image: modal.Image) -> modal.Image:
    """Ship this folder into the container and make `audio8q` importable."""
    # build steps (including .env) must come before add_local_dir
    return image.env({"PYTHONPATH": REPO_REMOTE}).add_local_dir(
        str(LOCAL_ROOT),
        remote_path=REPO_REMOTE,
        ignore=["__pycache__", "*.pyc", "out/**", "logs/**", ".venv/**", "data/**", "*.npy"],
    )


def run_dir(run: str) -> str:
    return os.path.join(VOLUME_ROOT, run)


def prepare_run(run: str) -> str:
    path = run_dir(run)
    os.makedirs(path, exist_ok=True)
    return path


def load_audio8(dtype: str = "bfloat16"):
    """Processor + model on CUDA (or CPU when this is a local test)."""
    import torch
    from transformers import AutoModel, AutoProcessor

    processor = AutoProcessor.from_pretrained(MODEL_DIR, trust_remote_code=True)
    torch_dtype = getattr(torch, dtype)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cpu":
        torch_dtype = torch.float32
    model = (
        AutoModel.from_pretrained(MODEL_DIR, trust_remote_code=True, dtype=torch_dtype)
        .eval()
        .to(device)
    )
    return processor, model


def refs_payload() -> dict:
    with open(LOCAL_ROOT / "refs" / "refs.json", encoding="utf-8") as handle:
        return json.load(handle)


def texts_payload(limit: int | None = None) -> dict:
    sys.path.insert(0, str(LOCAL_ROOT))
    from audio8q import texts as textmod

    ids = textmod.text_ids()[: limit or len(textmod.text_ids())]
    return {i: textmod.get(i) for i in ids}


def ref_dir() -> str:
    return os.path.join(REPO_REMOTE, "refs")


def gpu_name() -> str:
    import torch

    return torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu"
