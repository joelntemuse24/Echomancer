"""
VoxCPM2 TTS Server — vLLM-Omni serving for maximum throughput.
Runs alongside the legacy voxcpm_server.py; switch via MODAL_TTS_URL env var.

NOTE: This is an experimental deployment. Before production use:
  1. Deploy and test the /generate endpoint with a single request
  2. Verify audio quality matches the legacy server
  3. Test the /generate_batch endpoint with 8-16 parallel texts
  4. Update .env.local MODAL_TTS_URL to point here
"""

import modal
from pydantic import BaseModel
from typing import Optional, List
import time

# ---------------------------------------------------------------------------
# Image build — install vLLM-Omni + VoxCPM2, patch HF config, cache weights
# ---------------------------------------------------------------------------

def _patch_voxcpm_config():
    """Run during image build to create HF-compatible config for vLLM-Omni."""
    import json
    import os

    config_path = "/models/VoxCPM2/config.json"
    gen_config_path = "/models/VoxCPM2/generation_config.json"
    hf_dir = "/models/voxcpm_hf_config"
    os.makedirs(hf_dir, exist_ok=True)

    with open(config_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    cfg["model_type"] = "voxcpm"
    cfg.setdefault("architectures", ["VoxCPMForConditionalGeneration"])
    with open(os.path.join(hf_dir, "config.json"), "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)

    if os.path.exists(gen_config_path):
        import shutil
        shutil.copy(gen_config_path, os.path.join(hf_dir, "generation_config.json"))


image = (
    modal.Image.from_registry(
        "pytorch/pytorch:2.5.1-cuda12.1-cudnn9-runtime",
        add_python="3.11"
    )
    .apt_install("git", "ffmpeg", "libsndfile1", "espeak-ng", "build-essential", "curl")
    .pip_install(
        "voxcpm",
        "soundfile",
        "numpy",
        # vLLM-Omni — no version pin; install latest compatible
        "vllm-omni",
    )
    # Cache model weights into the image so cold start skips HF download
    .run_commands(
        "mkdir -p /models && hf download openbmb/VoxCPM2 --local-dir /models/VoxCPM2"
    )
    .run_function(_patch_voxcpm_config)
)

app = modal.App("echomancer-vllm-tts", image=image)


# ---------------------------------------------------------------------------
# Request/response schemas (mirror legacy server shape)
# ---------------------------------------------------------------------------

class TTSSingleRequest(BaseModel):
    text: str
    reference_audio_base64: Optional[str] = None
    reference_text: Optional[str] = None
    cfg_value: float = 2.0
    inference_timesteps: int = 10


class TTSBatchRequest(BaseModel):
    texts: List[str]
    reference_audio_base64: Optional[str] = None
    reference_text: Optional[str] = None
    cfg_value: float = 2.0
    inference_timesteps: int = 10


# ---------------------------------------------------------------------------
# Server class — spins up vllm serve on an ephemeral port inside the container
# ---------------------------------------------------------------------------

@app.cls(
    gpu="H100",
    scaledown_window=1800,          # 30 min idle — enough for bursty book jobs
    timeout=1200,                   # 20 min — first cold start + long batch
    allow_concurrent_inputs=10,     # vLLM handles real concurrency internally
)
class VoxCPMVLLMServer:
    @modal.enter()
    def setup(self):
        import os
        import subprocess
        import tempfile
        import soundfile as sf
        import numpy as np
        import json
        import urllib.request

        # vLLM-Omni expects HF-compatible config via env var
        os.environ["VLLM_OMNI_VOXCPM_HF_CONFIG_PATH"] = "/models/voxcpm_hf_config"
        os.environ["VLLM_OMNI_VOXCPM_CODE_PATH"] = "/usr/local/lib/python3.11/site-packages/voxcpm"

        # Build a short synthetic reference audio for warmup.
        # Band-limited noise (80Hz–8kHz) is closer to speech spectra than a pure tone,
        # reducing the chance the voice encoder rejects it as invalid.
        rng = np.random.default_rng(42)
        n_samples = int(48000 * 3.0)
        white = rng.standard_normal(n_samples).astype(np.float32)
        hp_window = int(48000 / 80)
        lp_window = int(48000 / 8000)
        hp = white - np.convolve(white, np.ones(hp_window) / hp_window, mode="same")
        lp = np.convolve(hp, np.ones(lp_window) / lp_window, mode="same")
        dummy_samples = 0.15 * (lp / (np.max(np.abs(lp)) + 1e-8))
        self._warmup_ref_path = "/tmp/voxcpm_warmup_ref.wav"
        sf.write(self._warmup_ref_path, dummy_samples, 48000)

        self.port = 28091
        model_path = "/models/VoxCPM2"
        # Use voxcpm.yaml (throughput/batching config), NOT async-chunk streaming config
        stage_config = "vllm_omni/model_executor/stage_configs/voxcpm.yaml"

        cmd = [
            "python", "-m", "vllm", "serve", model_path,
            "--stage-configs-path", stage_config,
            "--trust-remote-code",
            "--omni",
            "--port", str(self.port),
            "--max-model-len", "16384",
            "--dtype", "bfloat16",
            "--max-num-seqs", "32",
        ]

        # Redirect stdout/stderr to a log file to avoid PIPE deadlock
        log_path = "/tmp/vllm_serve.log"
        self._log_file = open(log_path, "w")
        print(f"[setup] Starting vllm serve on port {self.port} (logs → {log_path}) ...")
        self.proc = subprocess.Popen(
            cmd,
            stdout=self._log_file,
            stderr=subprocess.STDOUT,
        )

        # Health-check loop: wait until /health returns 200
        health_url = f"http://127.0.0.1:{self.port}/health"
        start = time.monotonic()
        while time.monotonic() - start < 300:
            try:
                req = urllib.request.Request(health_url, method="GET")
                with urllib.request.urlopen(req, timeout=2) as resp:
                    if resp.status == 200:
                        print("[setup] vllm serve health-check passed")
                        break
            except Exception:
                pass
            time.sleep(1)
        else:
            self._log_file.flush()
            try:
                with open(log_path, "r") as f:
                    logs = f.read()
            except Exception:
                logs = "(could not read log file)"
            print(f"[setup] vllm serve FAILED to start. Logs:\n{logs}")
            raise RuntimeError("vllm serve failed to start within 300s")

        # Warm-up request: vLLM captures CUDA graphs and JIT-compiles on first request.
        # Non-fatal if it fails — first real request will just be slower.
        warmup_payload = json.dumps({
            "model": "openbmb/VoxCPM2",
            "input": "Warm up.",
            "ref_audio": self._warmup_ref_path,
            "ref_text": "Warm up.",
            "response_format": "wav",
        }).encode("utf-8")

        warmup_url = f"http://127.0.0.1:{self.port}/v1/audio/speech"
        req = urllib.request.Request(
            warmup_url,
            data=warmup_payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                _ = resp.read()
            print("[setup] Warm-up request succeeded — CUDA graphs captured")
        except Exception as e:
            print(f"[setup] Warm-up request failed (non-fatal): {e}")

    @modal.exit()
    def teardown(self):
        if hasattr(self, "proc") and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except Exception:
                self.proc.kill()
        if hasattr(self, "_log_file") and self._log_file:
            self._log_file.close()

    # -----------------------------------------------------------------------
    # Internal helpers
    # -----------------------------------------------------------------------

    def _write_ref_audio(self, base64_audio: Optional[str]) -> Optional[str]:
        if not base64_audio:
            return None
        import base64
        import tempfile
        import soundfile as sf
        import io
        import os

        raw = base64.b64decode(base64_audio)
        with io.BytesIO(raw) as buf:
            audio, sr = sf.read(buf)
        if len(audio.shape) > 1:
            audio = audio.mean(axis=1)
        # Use NamedTemporaryFile (secure) instead of deprecated mktemp
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        sf.write(tmp.name, audio, sr)
        tmp.close()
        return tmp.name

    def _send_single(self, text: str, ref_path: Optional[str], ref_text: Optional[str]) -> bytes:
        """Send one request to vLLM-Omni /v1/audio/speech and return raw WAV bytes."""
        import json
        import urllib.request

        payload = {
            "model": "openbmb/VoxCPM2",
            "input": text,
            "response_format": "wav",
        }
        if ref_path:
            payload["ref_audio"] = ref_path
            if ref_text:
                payload["ref_text"] = ref_text

        url = f"http://127.0.0.1:{self.port}/v1/audio/speech"
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=600) as resp:
            # vLLM-Omni returns raw binary audio data (WAV), not JSON
            return resp.read()

    # -----------------------------------------------------------------------
    # FastAPI endpoints
    # -----------------------------------------------------------------------

    @modal.fastapi_endpoint(method="POST")
    def generate(self, request: TTSSingleRequest):
        """Single-section endpoint. Returns base64-encoded WAV."""
        import os
        import base64

        ref_path = self._write_ref_audio(request.reference_audio_base64)
        try:
            wav_bytes = self._send_single(request.text, ref_path, request.reference_text)
            return {
                "audio_base64": base64.b64encode(wav_bytes).decode(),
                "sample_rate": 48000,
                "duration_seconds": 0.0,
            }
        except Exception as e:
            import traceback
            return {"error": str(e), "traceback": traceback.format_exc()}
        finally:
            if ref_path and os.path.exists(ref_path):
                os.unlink(ref_path)

    @modal.fastapi_endpoint(method="POST")
    def generate_batch(self, request: TTSBatchRequest):
        """Batch endpoint.

        vLLM-Omni does NOT expose a /v1/audio/speech/batch endpoint.
        Instead, we send requests in parallel via a thread pool.
        vLLM's continuous batching engine will fuse them on the GPU.
        """
        import os
        import base64
        import concurrent.futures

        ref_path = self._write_ref_audio(request.reference_audio_base64)
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(request.texts), 16)) as pool:
                futures = [
                    pool.submit(self._send_single, text, ref_path, request.reference_text)
                    for text in request.texts
                ]

            # Collect in input order (futures list preserves order)
            ordered = [None] * len(request.texts)
            error_indices = []
            for i, fut in enumerate(futures):
                try:
                    wav_bytes = fut.result()
                    ordered[i] = {
                        "audio_base64": base64.b64encode(wav_bytes).decode(),
                        "sample_rate": 48000,
                        "duration_seconds": 0.0,
                    }
                except Exception as e:
                    ordered[i] = {"error": str(e)}
                    error_indices.append(i)

            response = {"results": ordered, "total": len(ordered)}
            if error_indices:
                response["errors"] = error_indices
            return response

        except Exception as e:
            import traceback
            return {"error": str(e), "traceback": traceback.format_exc()}
        finally:
            if ref_path and os.path.exists(ref_path):
                os.unlink(ref_path)


# ---------------------------------------------------------------------------
# Standalone health endpoint (always warm, separate container)
# ---------------------------------------------------------------------------

@app.function(image=image)
@modal.fastapi_endpoint(method="GET")
def health():
    return {"status": "ok", "model": "VoxCPM2-vLLM", "sample_rate": 48000}
