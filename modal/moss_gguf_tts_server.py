"""Isolated MOSS-TTS-v1.5 Q4_K_M quality/cost candidate on Modal L4."""

from __future__ import annotations

import base64
import io
import json
import os
import shutil
import subprocess
import tempfile
import time
import traceback
from pathlib import Path

import modal

APP_NAME = "echomancer-moss-gguf-candidate"
MODEL_ID = "OpenMOSS-Team/MOSS-TTS-v1.5"
BACKEND_LABEL = "v1.5-q4km-torch-heads-onnx-cuda-lowmem"
OUTPUT_SAMPLE_RATE = 24000
MODEL_ROOT = Path("/models/moss-v15-q4")
MARKER_PATH = MODEL_ROOT / "ready.json"
GPU_CONFIG = "L4"

MOSS_TTS_COMMIT = "ad99ec5f26debf1d6c1a4dc8461b2bcb787ec9af"
LLAMA_CPP_COMMIT = "0cd4f4720b71dd7eb5fb3e3e86ffdd8ec5ac7c9f"
MOSS_V15_REVISION = "cdd3b911b1585e3f2dbc7775ef10f9926f58850a"
ONNX_REVISION = "c7468e67a0ce987a6a76c4dfb3314e400cc335a2"

model_volume = modal.Volume.from_name(
    "moss-tts-v15-gguf-cache-v1", create_if_missing=True
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
        "ffmpeg",
        "git",
        "libsndfile1",
        "ninja-build",
    )
)


def _build_llama_runtime() -> None:
    """Compile the pinned CUDA runtime with enough builder CPU and time."""
    commands = [
        ["git", "clone", "https://github.com/OpenMOSS/MOSS-TTS.git", "/opt/MOSS-TTS"],
        ["git", "-C", "/opt/MOSS-TTS", "checkout", MOSS_TTS_COMMIT],
        ["git", "-C", "/opt/MOSS-TTS", "submodule", "update", "--init", "--recursive"],
        ["git", "clone", "https://github.com/ggml-org/llama.cpp.git", "/opt/llama.cpp"],
        ["git", "-C", "/opt/llama.cpp", "checkout", LLAMA_CPP_COMMIT],
        [
            "cmake", "-S", "/opt/llama.cpp", "-B", "/opt/llama.cpp/build",
            "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release", "-DGGML_CUDA=ON",
            "-DCMAKE_CUDA_ARCHITECTURES=89", "-DGGML_NATIVE=OFF",
            "-DBUILD_SHARED_LIBS=ON",
        ],
        [
            "cmake", "--build", "/opt/llama.cpp/build",
            "--target", "llama", "-j8",
        ],
        [
            "cmake", "-S", "/opt/llama.cpp", "-B", "/opt/llama.cpp/build-cpu",
            "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release", "-DGGML_CUDA=OFF",
            "-DGGML_NATIVE=OFF", "-DBUILD_SHARED_LIBS=ON",
        ],
        [
            "cmake", "--build", "/opt/llama.cpp/build-cpu",
            "--target", "llama-quantize", "-j8",
        ],
        [
            "bash",
            "/opt/MOSS-TTS/moss_tts_delay/llama_cpp/build_bridge.sh",
            "/opt/llama.cpp",
        ],
    ]
    for command in commands:
        print(f"[GGUF Build] {' '.join(command)}")
        subprocess.run(command, check=True)


runtime_image = (
    base_image
    .run_function(
        _build_llama_runtime,
        cpu=8,
        memory=32768,
        timeout=7200,
    )
    .run_commands(
        "pip install --index-url https://download.pytorch.org/whl/cu128 "
        "'torch==2.9.1+cu128'",
        "pip install -e '/opt/MOSS-TTS[llama-cpp-onnx]'",
        "pip install fastapi uvicorn huggingface_hub sentencepiece "
        "soundfile transformers",
        "ln -sf /usr/local/cuda/lib64/stubs/libcuda.so "
        "/usr/local/cuda/lib64/stubs/libcuda.so.1 && "
        "LD_LIBRARY_PATH=/usr/local/cuda/lib64/stubs:$LD_LIBRARY_PATH "
        "ldd /opt/MOSS-TTS/moss_tts_delay/llama_cpp/"
        "libbackbone_bridge.so | tee /tmp/bridge-ldd.txt",
        "! grep -q 'not found' /tmp/bridge-ldd.txt",
    )
    .env(
        {
            "LD_LIBRARY_PATH": (
                "/opt/llama.cpp/build/bin:/opt/llama.cpp/build/src:"
                "/usr/local/cuda/lib64:/usr/local/nvidia/lib:"
                "/usr/local/nvidia/lib64"
            ),
            "PYTHONPATH": "/opt/MOSS-TTS",
        }
    )
    .add_local_python_source("emotion_instruct")
)

app = modal.App(APP_NAME)


def _run(command: list[str], cwd: str | None = None) -> None:
    print(f"[GGUF Prep] Running: {' '.join(command)}")
    subprocess.run(command, cwd=cwd, check=True)


@app.function(
    image=runtime_image,
    cpu=8,
    memory=32768,
    timeout=86400,
    volumes={"/models": model_volume},
)
def prepare_models() -> dict:
    """Download, convert, and quantize the official v1.5 weights once."""
    from huggingface_hub import snapshot_download

    if MARKER_PATH.exists():
        marker = json.loads(MARKER_PATH.read_text())
        if (
            marker.get("moss_v15_revision") == MOSS_V15_REVISION
            and marker.get("onnx_revision") == ONNX_REVISION
            and marker.get("moss_tts_runtime_commit") == MOSS_TTS_COMMIT
            and marker.get("llama_cpp_commit") == LLAMA_CPP_COMMIT
        ):
            return marker
        raise RuntimeError("Prepared model revision does not match candidate code")

    work_root = Path("/models/moss-v15-prep")
    staging_root = Path("/models/moss-v15-q4-staging")
    source_dir = work_root / "source"
    extracted_dir = work_root / "extracted"
    onnx_dir = staging_root / "audio-tokenizer-onnx"
    f16_path = work_root / "backbone-f16.gguf"
    q4_path = staging_root / "backbone-q4km.gguf"

    shutil.rmtree(work_root, ignore_errors=True)
    shutil.rmtree(staging_root, ignore_errors=True)
    if MODEL_ROOT.exists():
        shutil.rmtree(MODEL_ROOT, ignore_errors=True)
    work_root.mkdir(parents=True, exist_ok=True)
    staging_root.mkdir(parents=True, exist_ok=True)

    snapshot_download(
        MODEL_ID,
        revision=MOSS_V15_REVISION,
        local_dir=source_dir,
    )
    _run(
        [
            "python",
            "/opt/MOSS-TTS/moss_tts_delay/llama_cpp/conversion/extract_weights.py",
            "--model",
            str(source_dir),
            "--output",
            str(extracted_dir),
        ]
    )
    _run(
        [
            "python",
            "/opt/llama.cpp/convert_hf_to_gguf.py",
            str(extracted_dir / "qwen3_backbone"),
            "--outfile",
            str(f16_path),
            "--outtype",
            "f16",
        ]
    )
    _run(
        [
            "env",
            "LD_LIBRARY_PATH=/opt/llama.cpp/build-cpu/bin",
            "/opt/llama.cpp/build-cpu/bin/llama-quantize",
            str(f16_path),
            str(q4_path),
            "Q4_K_M",
        ]
    )

    shutil.copytree(
        extracted_dir / "embeddings",
        staging_root / "embeddings",
        dirs_exist_ok=True,
    )
    shutil.copytree(
        extracted_dir / "lm_heads",
        staging_root / "lm_heads",
        dirs_exist_ok=True,
    )
    tokenizer_dir = staging_root / "tokenizer"
    tokenizer_dir.mkdir(parents=True, exist_ok=True)
    for source in (extracted_dir / "qwen3_backbone").iterdir():
        if "tokenizer" in source.name or source.name in {
            "added_tokens.json",
            "merges.txt",
            "vocab.json",
        }:
            shutil.copy2(source, tokenizer_dir / source.name)

    snapshot_download(
        "OpenMOSS-Team/MOSS-Audio-Tokenizer-ONNX",
        revision=ONNX_REVISION,
        local_dir=onnx_dir,
        allow_patterns=[
            "encoder.onnx",
            "encoder.data",
            "decoder.onnx",
            "decoder.data",
        ],
    )

    marker = {
        "model": MODEL_ID,
        "moss_v15_revision": MOSS_V15_REVISION,
        "onnx_revision": ONNX_REVISION,
        "moss_tts_runtime_commit": MOSS_TTS_COMMIT,
        "llama_cpp_commit": LLAMA_CPP_COMMIT,
        "quantization": "Q4_K_M",
        "backend": BACKEND_LABEL,
        "created_at": time.time(),
    }

    expected = [
        q4_path,
        tokenizer_dir / "tokenizer.json",
        onnx_dir / "encoder.onnx",
        onnx_dir / "encoder.data",
        onnx_dir / "decoder.onnx",
        onnx_dir / "decoder.data",
    ]
    missing = [str(path) for path in expected if not path.exists()]
    embedding_count = len(list((staging_root / "embeddings").glob("*.npy")))
    head_count = len(list((staging_root / "lm_heads").glob("*.npy")))
    if missing or embedding_count != 33 or head_count != 33:
        raise RuntimeError(
            f"Incomplete preparation: missing={missing}, "
            f"embeddings={embedding_count}, heads={head_count}"
        )

    # Conversion intermediates are not needed by workers.
    shutil.rmtree(work_root, ignore_errors=True)
    (staging_root / "ready.json").write_text(json.dumps(marker))
    os.replace(staging_root, MODEL_ROOT)
    model_volume.commit()
    return marker


def _pipeline_config():
    from moss_tts_delay.llama_cpp import PipelineConfig

    return PipelineConfig(
        backbone_gguf=str(MODEL_ROOT / "backbone-q4km.gguf"),
        embedding_dir=str(MODEL_ROOT / "embeddings"),
        lm_head_dir=str(MODEL_ROOT / "lm_heads"),
        tokenizer_dir=str(MODEL_ROOT / "tokenizer"),
        audio_backend="onnx",
        audio_encoder_onnx=str(
            MODEL_ROOT / "audio-tokenizer-onnx" / "encoder.onnx"
        ),
        audio_decoder_onnx=str(
            MODEL_ROOT / "audio-tokenizer-onnx" / "decoder.onnx"
        ),
        heads_backend="torch",
        n_ctx=8192,
        n_batch=512,
        n_threads=8,
        n_gpu_layers=-1,
        max_new_tokens=4096,
        use_gpu_audio=True,
        low_memory=True,
        kv_cache_type_k="q8_0",
        kv_cache_type_v="q8_0",
        flash_attn="enabled",
        text_temperature=1.5,
        text_top_p=1.0,
        text_top_k=50,
        audio_temperature=1.7,
        audio_top_p=0.8,
        audio_top_k=25,
        audio_repetition_penalty=1.0,
    )


@app.cls(
    image=runtime_image,
    gpu=GPU_CONFIG,
    cpu=4,
    memory=32768,
    timeout=3600,
    scaledown_window=600,
    max_containers=5,
    volumes={"/models": model_read_volume},
)
class MossGgufWorker:
    @modal.enter()
    def setup(self):
        from moss_tts_delay.llama_cpp import LlamaCppPipeline
        import onnxruntime as ort

        model_read_volume.reload()
        if not MARKER_PATH.exists():
            raise RuntimeError("GGUF model volume is not prepared")
        providers = ort.get_available_providers()
        if "CUDAExecutionProvider" not in providers:
            raise RuntimeError(
                f"ONNX CUDA provider unavailable; providers={providers}"
            )
        self.pipeline = LlamaCppPipeline(_pipeline_config())
        print(f"[GGUF Worker] Ready: {MARKER_PATH.read_text()}")

    @modal.method()
    def generate(
        self,
        text: str,
        reference_audio_base64: str,
        moss_language: str = "English",
        narration_instructions: str = "",
        sentence_pause_sec: float = 0.22,
        audio_temperature: float = 1.7,
        audio_top_p: float = 0.8,
        audio_top_k: int = 25,
        seed: int = 42,
    ) -> dict:
        import numpy as np
        import soundfile as sf
        from emotion_instruct import apply_moss_pacing

        request_started = time.time()
        temp_dir = tempfile.mkdtemp(prefix="moss_gguf_")
        try:
            if not text.strip():
                raise ValueError("Text is empty")
            if len(text) > 2500:
                raise ValueError("Text exceeds the 2500-character candidate limit")
            try:
                reference_bytes = base64.b64decode(
                    reference_audio_base64, validate=True
                )
            except Exception as exc:
                raise ValueError("Reference audio is not valid base64") from exc
            if not reference_bytes or len(reference_bytes) > 20 * 1024 * 1024:
                raise ValueError("Reference audio must be between 1 byte and 20 MB")

            ref_input_path = os.path.join(temp_dir, "reference_input")
            ref_path = os.path.join(temp_dir, "reference.wav")
            Path(ref_input_path).write_bytes(reference_bytes)
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-i",
                    ref_input_path,
                    "-t",
                    "30",
                    "-ac",
                    "1",
                    "-ar",
                    str(OUTPUT_SAMPLE_RATE),
                    ref_path,
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            ref_audio, ref_sr = sf.read(ref_path, dtype="float32")
            if (
                ref_sr != OUTPUT_SAMPLE_RATE
                or ref_audio.size == 0
                or not np.isfinite(ref_audio).all()
            ):
                raise ValueError("Reference audio could not be normalized")

            paced_text = apply_moss_pacing(
                text, sentence_pause_sec=sentence_pause_sec
            )
            np.random.seed(seed)
            sampling = self.pipeline.sampling_config
            original = (
                sampling.audio_temperature,
                sampling.audio_top_p,
                sampling.audio_top_k,
            )
            sampling.audio_temperature = audio_temperature
            sampling.audio_top_p = audio_top_p
            sampling.audio_top_k = audio_top_k
            pipeline_started = time.time()
            try:
                waveform = self.pipeline.generate(
                    text=paced_text,
                    reference_audio=ref_path,
                    instruction=narration_instructions or None,
                    language=moss_language,
                    max_new_tokens=4096,
                )
            finally:
                (
                    sampling.audio_temperature,
                    sampling.audio_top_p,
                    sampling.audio_top_k,
                ) = original

            waveform = np.asarray(waveform, dtype=np.float32).reshape(-1)
            if waveform.size == 0:
                raise RuntimeError("GGUF pipeline returned no audio")
            output = io.BytesIO()
            sf.write(
                output,
                waveform,
                OUTPUT_SAMPLE_RATE,
                format="WAV",
                subtype="PCM_16",
            )
            return {
                "status": "success",
                "audio_base64": base64.b64encode(output.getvalue()).decode(),
                "duration_seconds": waveform.size / OUTPUT_SAMPLE_RATE,
                "pipeline_seconds": time.time() - pipeline_started,
                "wall_seconds": time.time() - request_started,
                "pipeline_timings": dict(self.pipeline._timings),
                "sample_rate": OUTPUT_SAMPLE_RATE,
                "backend": BACKEND_LABEL,
            }
        except Exception as exc:
            traceback.print_exc()
            return {"status": "error", "error": str(exc), "backend": BACKEND_LABEL}
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    @modal.method()
    def warmup(self) -> dict:
        started = time.time()
        waveform = self.pipeline.generate(
            text="This is a bounded warmup for the quantized narration worker.",
            language="English",
            max_new_tokens=512,
        )
        if len(waveform) == 0:
            raise RuntimeError("GGUF warmup returned no audio")
        return {
            "status": "ready",
            "model": MODEL_ID,
            "backend": BACKEND_LABEL,
            "gpu": GPU_CONFIG,
            "audio_seconds": len(waveform) / OUTPUT_SAMPLE_RATE,
            "wall_seconds": time.time() - started,
        }


@app.function(
    image=runtime_image,
    timeout=1800,
    volumes={"/models": model_read_volume},
)
@modal.asgi_app()
def fastapi_app():
    from fastapi import FastAPI, HTTPException
    from fastapi.responses import JSONResponse

    web_app = FastAPI(title="Echomancer MOSS-TTS GGUF Candidate")

    @web_app.get("/health")
    async def health() -> JSONResponse:
        model_read_volume.reload()
        return JSONResponse(
            {
                "status": "ok" if MARKER_PATH.exists() else "models_missing",
                "model": MODEL_ID,
                "quantization": "Q4_K_M",
                "backend": BACKEND_LABEL,
                "gpu": GPU_CONFIG,
                "max_workers": 5,
                "production": False,
                "timestamp": time.time(),
            }
        )

    @web_app.post("/warmup")
    async def warmup() -> JSONResponse:
        result = await MossGgufWorker().warmup.remote.aio()
        return JSONResponse(result)

    @web_app.post("/generate_batch")
    async def generate_batch(request: dict) -> JSONResponse:
        try:
            texts = request.get("texts") or [request.get("text", "Hello.")]
            worker = MossGgufWorker()
            results = []
            for text in texts:
                result = await worker.generate.remote.aio(
                    text,
                    request["reference_audio_base64"],
                    request.get("moss_language", "English"),
                    request.get("narration_instructions", ""),
                    request.get("sentence_pause_sec", 0.22),
                    request.get("audio_temperature", 1.7),
                    request.get("audio_top_p", 0.8),
                    request.get("audio_top_k", 25),
                    request.get("seed", 42),
                )
                results.append(
                    {
                        "audio_base64": result.get("audio_base64"),
                        "duration_seconds": result.get("duration_seconds", 0),
                        "pipeline_seconds": result.get("pipeline_seconds", 0),
                        "wall_seconds": result.get("wall_seconds", 0),
                        "error": result.get("error"),
                        "pipeline_path": BACKEND_LABEL,
                    }
                )
            return JSONResponse(
                {
                    "results": results,
                    "pipeline_mode": "moss",
                    "variant": "gguf-candidate",
                    "model": MODEL_ID,
                    "quantization": "Q4_K_M",
                }
            )
        except Exception as exc:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=str(exc))

    return web_app
