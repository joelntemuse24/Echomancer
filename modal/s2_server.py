"""Fish Speech S2-Pro on Modal, using GPU memory snapshots to cut cold start.

Why this exists: the old `modal/` tree was removed when TTS moved to the
self-hosted Paradee sidecar. This restores a GPU path for S2-Pro.

An earlier draft tried to run `torch.compile` during the image build. That does
not work: Modal image builders have no GPU, so a CUDA compile step fails with
"No NVIDIA driver on your system". Modal's own guidance is the opposite approach
— keep the expensive GPU work in `@modal.enter(snap=True)` and let a GPU Memory
Snapshot capture the result. Their docs report 3-10x faster starts for
initialization-heavy functions, and show `torch.compile` inside a snapshot hook
as the canonical example.

Measured inputs, from the int4 fork's docs (`docs/en/4gb-laptop.md`):
    RTF 0.66-0.89 steady state on a 4 GB laptop card
    first start 4-5 minutes, of which ~116 s is `torch.compile`

Deploy:
    modal deploy modal/s2_server.py

Benchmark — this is what settles the cold-start question:
    modal run modal/s2_server.py::benchmark

Environment overrides:
    S2_MODEL_ID   default fishaudio/s2-pro
    S2_GPU        default A10
    S2_SNAPSHOT   1 = GPU memory snapshot on (default), 0 = plain cold start
"""

from __future__ import annotations

import os
import time

import modal

S2_GPU = os.environ.get("S2_GPU", "A10")
S2_MODEL_ID = os.environ.get("S2_MODEL_ID", "fishaudio/s2-pro")
S2_SNAPSHOT = os.environ.get("S2_SNAPSHOT", "1") == "1"

APP_NAME = "echomancer-s2-pro"
VOLUME_NAME = "s2-pro-weights"

# Weights land in the image so no container pays an 8.5 GB download. This part
# genuinely does work at build time, since it needs no GPU.
HF_HOME = "/opt/hf"
# The inductor cache directory still helps: a snapshot captures the process,
# and any cache written to disk survives in layers built later.
TORCHINDUCTOR_CACHE_DIR = "/opt/torchinductor"

volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)

gpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "ffmpeg", "libsndfile1")
    .pip_install(
        "torch==2.5.1",
        "torchaudio==2.5.1",
        "numpy<2",
        "soundfile",
        "huggingface_hub",
        "transformers",
        "fastapi",
        "uvicorn",
    )
    .env(
        {
            "HF_HOME": HF_HOME,
            "TORCHINDUCTOR_CACHE_DIR": TORCHINDUCTOR_CACHE_DIR,
        }
    )
    .run_commands(
        # CPU-only work, so this is safe in a builder.
        f"python -c \"from huggingface_hub import snapshot_download; "
        f"snapshot_download('{S2_MODEL_ID}')\"",
        f"mkdir -p {TORCHINDUCTOR_CACHE_DIR}",
    )
)

app = modal.App(APP_NAME)

# GPU Memory Snapshots are alpha; the flag is only valid when enabled.
_CLS_KWARGS: dict = {
    "image": gpu_image,
    "gpu": S2_GPU,
    "memory": 16384,
    "scaledown_window": 300,
    "timeout": 3600,
    "volumes": {"/cache": volume},
    "max_containers": 8,
    "secrets": [modal.Secret.from_name("echomancer-secrets")],
    "env": {
        "HF_HOME": HF_HOME,
        "TORCHINDUCTOR_CACHE_DIR": TORCHINDUCTOR_CACHE_DIR,
    },
}
if S2_SNAPSHOT:
    _CLS_KWARGS["enable_memory_snapshot"] = True
    _CLS_KWARGS["experimental_options"] = {"enable_gpu_snapshot": True}


@app.cls(**_CLS_KWARGS)
class S2Worker:
    """Holds the model. Boot time is what the benchmark measures."""

    model: object = None
    tokenizer: object = None
    boot_started: float = 0.0
    model_ready_at: float = 0.0
    compiled_at: float = 0.0

    @modal.enter(snap=True)
    def load(self) -> None:
        """Everything expensive, and everything GPU-bound.

        Runs once when the snapshot is captured; later containers restore the
        resulting memory image instead of repeating it. Loading weights and
        calling `torch.compile` both belong here.
        """
        import torch

        self.boot_started = time.time()
        torch.cuda.init()

        self.model, self.tokenizer = _load_s2_model()
        self.model = torch.compile(self.model, mode="reduce-overhead")
        # A forward pass moves kernel selection and autotuning into the snapshot
        # rather than the first request. Modal's docs call this out directly:
        # without it, the work becomes tail latency after every boot.
        _warm_forward(self.model, self.tokenizer)
        self.compiled_at = time.time()

        print(f"[S2] warm in {self.compiled_at - self.boot_started:.1f}s")

    @modal.enter()
    def publish(self) -> None:
        """Cheap work that must happen after restore, not in the snapshot.

        Network clients and other handles that do not survive capture go here.
        """
        self.model_ready_at = time.time()
        print(f"[S2] ready {self.model_ready_at - self.compiled_at:.1f}s after snapshot")

    @modal.method()
    def warmup(self) -> dict:
        return {
            "status": "warm",
            "gpu": S2_GPU,
            "model": S2_MODEL_ID,
            "snapshot": S2_SNAPSHOT,
        }

    @modal.method()
    def timings(self) -> dict:
        """What this container actually paid, split by phase."""
        return {
            "gpu": S2_GPU,
            "snapshot": S2_SNAPSHOT,
            "init_s": round(self.compiled_at - self.boot_started, 1),
            "post_snapshot_s": round(self.model_ready_at - self.compiled_at, 1),
        }

    @modal.method()
    def synthesize(self, text: str, ref_audio_b64: str | None = None) -> dict:
        """Render one passage and report throughput against the 12x target."""
        import base64
        import io

        import soundfile as sf

        started = time.time()
        wav_bytes, sample_rate = _run_synthesis(
            self.model, self.tokenizer, text, ref_audio_b64
        )
        elapsed = time.time() - started

        data, sr = sf.read(io.BytesIO(wav_bytes))
        duration = len(data) / sr
        return {
            "status": "ok",
            "audio_b64": base64.b64encode(wav_bytes).decode(),
            "sample_rate": sample_rate,
            "duration_s": round(duration, 2),
            "wall_s": round(elapsed, 2),
            "realtime_factor": round(duration / elapsed, 2) if elapsed else 0,
            "chars": len(text),
        }


def _load_s2_model():
    """Load S2-Pro.

    The package layout differs between upstream safetensors and the int4 fork's
    `model.pth` + `codec.pth`. Wiring the real loader is the next step once the
    benchmark image is proven to build; the seam is kept in one place so the
    rest of the file does not change.
    """
    raise NotImplementedError("Point this at the S2-Pro loader")


def _warm_forward(model, tokenizer) -> None:
    """Representative forward pass, so autotuning lands in the snapshot."""
    raise NotImplementedError("Run one short synthesis here")


def _run_synthesis(model, tokenizer, text: str, ref_audio_b64: str | None):
    raise NotImplementedError("Wire the S2-Pro generate() call here")


# ── Benchmark ────────────────────────────────────────────────────────────────


@app.local_entrypoint()
def benchmark(parallel: int = 1, text_chars: int = 3800) -> None:
    """Measure cold start and throughput for the current configuration.

    Uses dedicated bench containers so the deployed app is never disturbed.
    """
    text = _sample_text(text_chars)
    print(f"gpu={S2_GPU} snapshot={S2_SNAPSHOT} parallel={parallel}\n")

    started = time.time()
    timing_calls = [S2Worker().timings.spawn() for _ in range(parallel)]
    timings = [c.get() for c in timing_calls]
    wall = time.time() - started

    for i, t in enumerate(timings):
        print(f"  worker {i}: init {t['init_s']}s + post {t['post_snapshot_s']}s")
    if timings:
        print(f"\nwall for {parallel} containers: {wall:.1f}s")

    print("\nthroughput:")
    calls = [S2Worker().synthesize.spawn(text) for _ in range(parallel)]
    for i, r in enumerate([c.get() for c in calls]):
        print(
            f"  worker {i}: {r['duration_s']}s audio in {r['wall_s']}s "
            f"= {r['realtime_factor']}x realtime"
        )


def _sample_text(target_chars: int) -> str:
    base = (
        "The river had not moved for three days. Elena stood at the window and "
        "watched the light change on the water, the way it always did before a "
        "storm. She had promised her brother that she would wait, but waiting "
        "had never suited her. "
    )
    return (base * (target_chars // len(base) + 1))[:target_chars]
