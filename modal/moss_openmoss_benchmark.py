"""Isolated full-C++ MOSS-TTS-v1.5 Q8 benchmark on Modal L4."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import subprocess
import time
from pathlib import Path

import modal

APP_NAME = "echomancer-openmoss-l4-bench"
OPENMOSS_COMMIT = "a694a577202c2c4471bb43af3b692de14bb7e8a6"
MODEL_REPO = "smcleod/MOSS-TTS-v1.5-GGUF"
MODEL_REVISION = "56eb386ffa40eff94265c1e00f4eabc80f9ca9bd"
MODEL_FILENAME = "moss-tts-v1.5-q8_0.gguf"
EXTRAS_FILENAME = "moss-tts-v1.5-q8_0.extras.gguf"
MODEL_SHA256 = "3f772163aa79968f1079279a86e85014daef969995861a8e56f56cfd364207be"
EXTRAS_SHA256 = "ce40f9991518614f1fd92101ca056485c1c4a84a20ddf9084afbd21624521609"
MODEL_ROOT = Path("/models/openmoss-v15-q8")
MARKER_PATH = MODEL_ROOT / "ready.json"
SERVER_PORT = 8080

model_volume = modal.Volume.from_name(
    "openmoss-v15-q8-bench-v1", create_if_missing=True
)
model_read_volume = model_volume.with_mount_options(read_only=True)

base_image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.8.1-devel-ubuntu24.04",
        add_python="3.12",
    )
    .entrypoint([])
    .apt_install(
        "build-essential",
        "cmake",
        "git",
        "ninja-build",
    )
)


def _build_openmoss() -> None:
    Path("/usr/local/cuda/lib64/stubs/libcuda.so.1").symlink_to(
        "/usr/local/cuda/lib64/stubs/libcuda.so"
    )
    build_env = os.environ.copy()
    build_env["LIBRARY_PATH"] = "/usr/local/cuda/lib64/stubs"
    build_env["LDFLAGS"] = (
        "-L/usr/local/cuda/lib64/stubs "
        "-Wl,-rpath-link,/usr/local/cuda/lib64/stubs"
    )
    commands = [
        [
            "git", "clone", "--branch", "v0.1.2", "--recurse-submodules",
            "https://github.com/pwilkin/openmoss.git", "/opt/openmoss",
        ],
        ["git", "-C", "/opt/openmoss", "checkout", "--detach", OPENMOSS_COMMIT],
        ["git", "-C", "/opt/openmoss", "submodule", "update", "--init", "--recursive"],
        [
            "cmake", "-S", "/opt/openmoss", "-B", "/opt/openmoss/build",
            "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release", "-DGGML_CUDA=ON",
            "-DCMAKE_CUDA_ARCHITECTURES=89", "-DGGML_NATIVE=OFF",
        ],
        [
            "cmake", "--build", "/opt/openmoss/build",
            "--target", "moss-tts-server", "-j8",
        ],
    ]
    for command in commands:
        print(f"[openmoss build] {' '.join(command)}")
        subprocess.run(command, check=True, env=build_env)


runtime_image = (
    base_image
    .run_function(
        _build_openmoss,
        cpu=8,
        memory=32768,
        timeout=7200,
    )
    .pip_install("httpx", "huggingface_hub")
    .env(
        {
            "LD_LIBRARY_PATH": (
                "/opt/openmoss/build/third_party/llama.cpp/bin:"
                "/opt/openmoss/build/bin:/usr/local/cuda/lib64:"
                "/usr/local/nvidia/lib:/usr/local/nvidia/lib64"
            )
        }
    )
)

app = modal.App(APP_NAME)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@app.function(
    image=runtime_image,
    cpu=4,
    memory=16384,
    timeout=7200,
    volumes={"/models": model_volume},
)
def prepare_models() -> dict:
    from huggingface_hub import snapshot_download

    if MARKER_PATH.exists():
        marker = json.loads(MARKER_PATH.read_text())
        if marker.get("revision") == MODEL_REVISION:
            return marker
        raise RuntimeError("Prepared openmoss revision does not match")

    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        MODEL_REPO,
        revision=MODEL_REVISION,
        local_dir=MODEL_ROOT,
        allow_patterns=[MODEL_FILENAME, EXTRAS_FILENAME],
    )
    model_path = MODEL_ROOT / MODEL_FILENAME
    extras_path = MODEL_ROOT / EXTRAS_FILENAME
    actual_model_sha = _sha256(model_path)
    actual_extras_sha = _sha256(extras_path)
    if actual_model_sha != MODEL_SHA256 or actual_extras_sha != EXTRAS_SHA256:
        raise RuntimeError(
            "Downloaded openmoss model hashes do not match pinned artifacts"
        )

    marker = {
        "repo": MODEL_REPO,
        "revision": MODEL_REVISION,
        "model_sha256": actual_model_sha,
        "extras_sha256": actual_extras_sha,
        "openmoss_commit": OPENMOSS_COMMIT,
        "created_at": time.time(),
    }
    MARKER_PATH.write_text(json.dumps(marker))
    model_volume.commit()
    return marker


@app.cls(
    image=runtime_image,
    gpu="L4",
    cpu=2,
    memory=16384,
    timeout=1800,
    scaledown_window=600,
    max_containers=1,
    volumes={"/models": model_read_volume},
)
class OpenMossWorker:
    @modal.enter()
    def start_server(self):
        import httpx

        model_read_volume.reload()
        if not MARKER_PATH.exists():
            raise RuntimeError("openmoss model volume is not prepared")
        self.started_at = time.time()
        self.process = subprocess.Popen(
            [
                "/opt/openmoss/build/moss-tts-server",
                "--model",
                str(MODEL_ROOT / MODEL_FILENAME),
                "--host",
                "127.0.0.1",
                "--port",
                str(SERVER_PORT),
                "--main-gpu",
                "0",
                "--n-gpu-layers",
                "-1",
                "--n-ctx",
                "8192",
                "--n-batch",
                "2048",
                "--no-webui",
            ]
        )
        deadline = time.time() + 600
        with httpx.Client(timeout=3) as client:
            while time.time() < deadline:
                if self.process.poll() is not None:
                    raise RuntimeError(
                        f"openmoss server exited with {self.process.returncode}"
                    )
                try:
                    if client.get(
                        f"http://127.0.0.1:{SERVER_PORT}/health"
                    ).status_code == 200:
                        self.ready_at = time.time()
                        print(
                            f"[openmoss] ready in "
                            f"{self.ready_at - self.started_at:.2f}s"
                        )
                        return
                except Exception:
                    pass
                time.sleep(2)
        raise RuntimeError("openmoss server did not become ready")

    @modal.exit()
    def stop_server(self):
        if getattr(self, "process", None) and self.process.poll() is None:
            self.process.terminate()

    @modal.method()
    def generate(
        self,
        text: str,
        reference_wav_base64: str,
        language: str = "English",
        seed: int = 42,
        audio_temperature: float = 1.7,
        audio_top_p: float = 0.8,
        audio_top_k: int = 25,
        audio_repetition_penalty: float = 1.0,
    ) -> dict:
        import httpx

        started = time.time()
        response = httpx.post(
            f"http://127.0.0.1:{SERVER_PORT}/tts",
            json={
                "text": text,
                "reference_wav_b64": reference_wav_base64,
                "language": language,
                "max_new_tokens": 4096,
                "sampling": {
                    "text_temperature": 1.5,
                    "text_top_p": 1.0,
                    "text_top_k": 50,
                    "audio_temperature": audio_temperature,
                    "audio_top_p": audio_top_p,
                    "audio_top_k": audio_top_k,
                    "audio_repetition_penalty": audio_repetition_penalty,
                    "seed": seed,
                },
            },
            timeout=900,
        )
        response.raise_for_status()
        return {
            "status": "success",
            "audio_base64": base64.b64encode(response.content).decode(),
            "wall_seconds": time.time() - started,
            "generate_seconds": float(
                response.headers.get("X-MOSS-Generate-Seconds", 0)
            ),
            "decode_seconds": float(
                response.headers.get("X-MOSS-Decode-Seconds", 0)
            ),
            "server_start_seconds": self.ready_at - self.started_at,
            "backend": "openmoss-v15-q8-l4",
        }

    @modal.method()
    def info(self) -> dict:
        import httpx

        response = httpx.get(
            f"http://127.0.0.1:{SERVER_PORT}/info",
            timeout=10,
        )
        response.raise_for_status()
        return {
            **response.json(),
            "server_start_seconds": self.ready_at - self.started_at,
            "backend": "openmoss-v15-q8-l4",
        }
