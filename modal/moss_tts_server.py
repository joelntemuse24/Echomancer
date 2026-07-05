"""
MOSS-TTS Server for Echomancer — OpenMOSS MOSS-TTS-v1.5 flagship (MossTTSDelay-8B).

Per paragraph:
  1. MOSS-TTS-v1.5 (A10G) — production zero-shot clone + long-form stability
  2. Optional explicit [pause X.Ys] markers for slow Wolfe-style passages

Deploy:
  modal deploy modal/moss_tts_server.py          # Delay-8B (A100)
  modal deploy modal/moss_local_tts_server.py    # Local-Transformer (L40S)

Set Vercel env:
  TTS_PIPELINE_MODE=moss
  MOSS_AB_VARIANT=delay|local
  MODAL_MOSS_TTS_URL=https://<user>--echomancer-moss-tts-fastapi-app.modal.run/generate_batch
  MODAL_MOSS_LOCAL_TTS_URL=https://<user>--echomancer-moss-local-tts-fastapi-app.modal.run/generate_batch
  MODAL_TTS_URL=<active variant URL>  # voice preview + warmup

Optional Modal env:
  MOSS_DECODE_PROFILE=delay|local|variant  (default delay — fidelity-first on both GPUs)
  MOSS_PARALLEL_MODE=wave|sequential|fast
  MOSS_MAX_WORKERS (default 5)
  MOSS_BATCH_CHARS (default 1500)

Rollback: set MOSS_AB_VARIANT=sglang|delay|local and point MODAL_TTS_URL at that Modal app.
"""

from __future__ import annotations

import base64
import importlib.util
import io
import os
import re
import shutil
import subprocess
import tempfile
import time
import traceback
from dataclasses import dataclass
from typing import List, Optional

import modal

from emotion_instruct import analyze_paragraph
from tts_shared import (
    MAX_PARAGRAPH_CHARS,
    PARAGRAPH_SILENCE,
    batch_seam_crossfade_duration,
    clip_audio_ffmpeg,
    concatenate_audio_ffmpeg,
    decode_audio_base64,
    download_and_load_book_text,
    download_from_r2,
    get_r2_client,
    insert_silence_between_chunks,
    normalize_audio_ffmpeg,
    smooth_batch_boundaries,
    normalize_punctuation,
    normalize_text,
    send_webhook_async,
    send_webhook_sync,
    split_text_into_paragraphs,
    transcribe_with_whisper,
    upload_to_r2,
    verify_r2_permissions,
)

_VARIANTS = {
    "delay": {
        "app_name": "echomancer-moss-tts",
        "model_id": "OpenMOSS-Team/MOSS-TTS-v1.5",
        "gpu": "A100",
        "volume_name": "moss-tts-cache-v1",
        "hf_snapshot": "OpenMOSS-Team/MOSS-TTS-v1.5",
        "label": "MossTTSDelay-8B",
    },
    "local": {
        "app_name": "echomancer-moss-local-tts",
        "model_id": "OpenMOSS-Team/MOSS-TTS-Local-Transformer-v1.5",
        "gpu": "L40S",
        "volume_name": "moss-local-tts-cache-v1",
        "hf_snapshot": "OpenMOSS-Team/MOSS-TTS-Local-Transformer-v1.5",
        "label": "Local-Transformer-v1.5",
    },
}

_DEPLOY_VARIANT = os.environ.get("MOSS_DEPLOY_VARIANT", "delay")
if _DEPLOY_VARIANT not in _VARIANTS:
    raise ValueError(f"Unknown MOSS_DEPLOY_VARIANT={_DEPLOY_VARIANT!r}")
_VARIANT_CFG = _VARIANTS[_DEPLOY_VARIANT]

MOSS_MODEL_ID = os.environ.get("MOSS_MODEL_ID", _VARIANT_CFG["model_id"])
DEFAULT_LANGUAGE = "English"
OUTPUT_SAMPLE_RATE = 24000
GPU_CONFIG = _VARIANT_CFG["gpu"]
# Parallel GPU containers per wave (fan-out branches after each anchor batch).
MOSS_MAX_WORKERS = int(os.environ.get("MOSS_MAX_WORKERS", "5"))
MAX_CONTAINERS = max(MOSS_MAX_WORKERS, 2)
CONTAINER_MEMORY_MIB = 65536
MAX_REF_SECONDS = 60
MOSS_VARIANT_LABEL = _VARIANT_CFG["label"]
# parallel: wave (default) | sequential (slowest, smoothest) | fast (independent clones)
MOSS_PARALLEL_MODE = os.environ.get("MOSS_PARALLEL_MODE", "wave").lower()
MOSS_VOICE_CONSISTENCY = MOSS_PARALLEL_MODE in {"wave", "sequential"} or os.environ.get(
    "MOSS_VOICE_CONSISTENCY", ""
).lower() in {"1", "true", "yes"}
# Larger batches = fewer wave seams. Shorter values only for deliberate clone-tight tests.
MOSS_BATCH_CHARS = int(os.environ.get("MOSS_BATCH_CHARS", "2500"))

# Use each model's own MOSS card defaults (best stability). Override: MOSS_DECODE_PROFILE=delay|local
_DECODE_PROFILES = {
    "delay": {
        "max_new_tokens": 4096,
        "audio_temperature": 1.7,
        "audio_top_p": 0.8,
        "audio_top_k": 25,
        "audio_repetition_penalty": 1.0,
    },
    "local": {
        "max_new_tokens": 4096,
        "audio_temperature": 1.0,
        "audio_top_p": 0.95,
        "audio_top_k": 50,
        "audio_repetition_penalty": 1.1,
    },
}
MOSS_DECODE_PROFILE = os.environ.get("MOSS_DECODE_PROFILE", "variant").lower()
if MOSS_DECODE_PROFILE == "variant":
    MOSS_GEN_KWARGS = _DECODE_PROFILES.get(_DEPLOY_VARIANT, _DECODE_PROFILES["delay"])
elif MOSS_DECODE_PROFILE in _DECODE_PROFILES:
    MOSS_GEN_KWARGS = _DECODE_PROFILES[MOSS_DECODE_PROFILE]
else:
    MOSS_GEN_KWARGS = _DECODE_PROFILES.get(_DEPLOY_VARIANT, _DECODE_PROFILES["delay"])

_HF_SNAPSHOT = _VARIANT_CFG["hf_snapshot"]
volume = modal.Volume.from_name(_VARIANT_CFG["volume_name"], create_if_missing=True)

cpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg", "libsndfile1")
    .pip_install(
        "fastapi",
        "uvicorn",
        "boto3",
        "httpx",
        "pymupdf",
        "num2words",
        "soundfile",
        "numpy<2",
        "faster-whisper",
    )
    .env({"MOSS_DEPLOY_VARIANT": _DEPLOY_VARIANT})
    .add_local_python_source("emotion_instruct")
    .add_local_python_source("tts_shared")
)

moss_gpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install(
        "git",
        "ffmpeg",
        "libsndfile1",
        "libavcodec-dev",
        "libavformat-dev",
        "libavutil-dev",
        "libavfilter-dev",
        "libavdevice-dev",
        "libswscale-dev",
        "libswresample-dev",
        "wget",
        "xz-utils",
    )
    .run_commands(
        # torchcodec needs FFmpeg *shared* libs — conda-forge is the reliable path
        "wget -qO- https://micro.mamba.pm/api/micromamba/linux-64/latest "
        "| tar -xvj bin/micromamba",
        "export MAMBA_ROOT_PREFIX=/opt/mamba && "
        "./bin/micromamba create -y -p /opt/ffmpeg-env -c conda-forge 'ffmpeg>=7'",
        "git clone --depth 1 https://github.com/OpenMOSS/MOSS-TTS.git /opt/MOSS-TTS",
        "pip install --extra-index-url https://download.pytorch.org/whl/cu128 "
        "-e '/opt/MOSS-TTS[torch-runtime]'",
        # CPU torchcodec wheel avoids CUDA libnvrtc linkage issues for audio I/O
        "pip install --force-reinstall 'torchcodec==0.9.0' "
        "--index-url https://download.pytorch.org/whl/cpu",
        "LD_LIBRARY_PATH=/opt/ffmpeg-env/lib python -c \"import torchcodec; print('torchcodec', torchcodec.__version__)\"",
        f"python -c \"from huggingface_hub import snapshot_download; "
        f"snapshot_download('{_HF_SNAPSHOT}')\"",
    )
    .env(
        {
            "PATH": "/opt/ffmpeg-env/bin:/usr/local/bin:/usr/bin:/bin",
            "LD_LIBRARY_PATH": "/opt/ffmpeg-env/lib:/usr/lib/x86_64-linux-gnu",
            "MOSS_DEPLOY_VARIANT": _DEPLOY_VARIANT,
        }
    )
    .pip_install("soundfile", "httpx", "boto3")
    .add_local_python_source("emotion_instruct")
    .add_local_python_source("tts_shared")
)

app = modal.App(_VARIANT_CFG["app_name"])


@dataclass
class AudiobookRequest:
    job_id: str
    pdf_r2_key: str
    voice_r2_key: str
    start_time: float
    end_time: float
    webhook_url: str
    book_title: str = "Untitled"
    voice_name: str = "Unknown"
    r2_bucket_name: str = "echomancer-audio"
    pipeline_mode: str = "moss"
    moss_language: str = DEFAULT_LANGUAGE


def _resolve_attn_implementation(device: str, dtype) -> str:
    import torch

    if (
        device == "cuda"
        and importlib.util.find_spec("flash_attn") is not None
        and dtype in {torch.float16, torch.bfloat16}
    ):
        major, _ = torch.cuda.get_device_capability()
        if major >= 8:
            return "flash_attention_2"
    if device == "cuda":
        return "sdpa"
    return "eager"


def _group_paragraphs_for_synthesis(
    paragraphs: list[dict],
    max_chars: int = MOSS_BATCH_CHARS,
) -> list[list[dict]]:
    """Group paragraphs into batches sized for stable long-form MOSS generation."""
    batches: list[list[dict]] = []
    current: list[dict] = []
    current_len = 0
    for para in paragraphs:
        text = para.get("text", "").strip()
        if not text:
            continue
        if current and current_len + len(text) > max_chars:
            batches.append(current)
            current = []
            current_len = 0
        current.append(para)
        current_len += len(text)
    if current:
        batches.append(current)
    return batches


def _join_batch_text(paragraphs: list[dict]) -> str:
    parts = [apply_moss_pacing(p.get("text", "").strip()) for p in paragraphs if p.get("text", "").strip()]
    return f" [pause {PARAGRAPH_SILENCE}s] ".join(parts)


def _trim_prefix_audio(output_wav_bytes: bytes, prefix_wav_path: str) -> bytes:
    """Remove prefix audio from continuation output so batches don't overlap."""
    import numpy as np
    import soundfile as sf

    out_data, out_sr = sf.read(io.BytesIO(output_wav_bytes))
    prefix_data, prefix_sr = sf.read(prefix_wav_path)
    if prefix_sr != out_sr:
        import librosa

        prefix_data = librosa.resample(prefix_data, orig_sr=prefix_sr, target_sr=out_sr)
    prefix_samples = len(prefix_data) if prefix_data.ndim == 1 else prefix_data.shape[0]
    if out_data.ndim == 1:
        trimmed = out_data[prefix_samples:]
    else:
        trimmed = out_data[prefix_samples:, :]
    if len(trimmed) == 0:
        return output_wav_bytes
    buf = io.BytesIO()
    sf.write(buf, trimmed.astype(np.float32), out_sr, format="WAV")
    buf.seek(0)
    return buf.read()


def apply_moss_pacing(text: str) -> str:
    """Add explicit pause markers for deliberately paced passages."""
    speed, _ = analyze_paragraph(text)
    if speed >= 0.85:
        return text
    paced = re.sub(r" — ", " — [pause 0.4s] ", text)
    paced = re.sub(r"; ", "; [pause 0.3s] ", paced)
    return paced


def _audio_tensor_to_mono_wav_bytes(audio_tensor, sample_rate: int) -> bytes:
    """Convert MOSS audio tensor (mono or stereo) to mono WAV at OUTPUT_SAMPLE_RATE."""
    import numpy as np
    import soundfile as sf

    audio = audio_tensor.detach().float().cpu().numpy()
    if audio.ndim == 2:
        # Flagship Delay: [samples]; Local-Transformer: [channels, samples]
        mono = audio.mean(axis=0) if audio.shape[0] <= 4 else audio.mean(axis=1)
    else:
        mono = audio

    if sample_rate != OUTPUT_SAMPLE_RATE:
        import librosa

        mono = librosa.resample(mono, orig_sr=sample_rate, target_sr=OUTPUT_SAMPLE_RATE)
        sample_rate = OUTPUT_SAMPLE_RATE

    buf = io.BytesIO()
    sf.write(buf, mono.astype(np.float32), sample_rate, format="WAV")
    buf.seek(0)
    return buf.read()


def _audio_bytes_to_base64(wav_bytes: bytes) -> str:
    return base64.b64encode(wav_bytes).decode("utf-8")


def _preload_ffmpeg_libs() -> None:
    """torchcodec needs FFmpeg shared objects on LD_LIBRARY_PATH before import."""
    import ctypes

    lib_dir = "/opt/ffmpeg-env/lib"
    if not os.path.isdir(lib_dir):
        return
    os.environ["LD_LIBRARY_PATH"] = f"{lib_dir}:{os.environ.get('LD_LIBRARY_PATH', '')}"
    for name in sorted(os.listdir(lib_dir)):
        if not (name.startswith(("libav", "libsw", "libpostproc")) and "so" in name):
            continue
        path = os.path.join(lib_dir, name)
        if not os.path.isfile(path):
            continue
        try:
            ctypes.CDLL(path, mode=ctypes.RTLD_GLOBAL)
        except OSError:
            pass


def _write_ref_wav(voice_base64: str, ref_path: str, max_seconds: float = MAX_REF_SECONDS) -> None:
    import soundfile as sf

    ref_audio, ref_sr = decode_audio_base64(voice_base64)
    max_samples = int(max_seconds * ref_sr)
    if len(ref_audio) > max_samples:
        start = (len(ref_audio) - max_samples) // 2
        ref_audio = ref_audio[start : start + max_samples]
    sf.write(ref_path, ref_audio, ref_sr)


# ── GPU: MOSS-TTS worker ───────────────────────────────────────────────────

@app.cls(
    image=moss_gpu_image,
    gpu=GPU_CONFIG,
    memory=CONTAINER_MEMORY_MIB,
    scaledown_window=600,
    timeout=3600,
    volumes={"/cache": volume},
    max_containers=MAX_CONTAINERS,
    secrets=[modal.Secret.from_name("echomancer-secrets")],
    env={
        "PATH": "/opt/ffmpeg-env/bin:/usr/local/bin:/usr/bin:/bin",
        "LD_LIBRARY_PATH": "/opt/ffmpeg-env/lib:/usr/lib/x86_64-linux-gnu",
        "MOSS_DEPLOY_VARIANT": _DEPLOY_VARIANT,
    },
)
class MossAudiobookWorker:
    processor: object = None
    model: object = None
    device: str = "cuda"
    dtype: object = None
    sample_rate: int = OUTPUT_SAMPLE_RATE

    @modal.enter()
    def setup(self):
        import torch
        from transformers import AutoModel, AutoProcessor

        _preload_ffmpeg_libs()
        torch.backends.cuda.enable_cudnn_sdp(False)
        torch.backends.cuda.enable_flash_sdp(True)
        torch.backends.cuda.enable_mem_efficient_sdp(True)
        torch.backends.cuda.enable_math_sdp(True)

        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.dtype = torch.bfloat16 if self.device == "cuda" else torch.float32
        attn = _resolve_attn_implementation(self.device, self.dtype)
        print(f"[MossWorker] Loading {MOSS_MODEL_ID} attn={attn}")

        os.makedirs("/cache/moss", exist_ok=True)
        self.processor = AutoProcessor.from_pretrained(
            MOSS_MODEL_ID,
            trust_remote_code=True,
        )
        self.processor.audio_tokenizer = self.processor.audio_tokenizer.to(self.device)
        self.model = AutoModel.from_pretrained(
            MOSS_MODEL_ID,
            trust_remote_code=True,
            attn_implementation=attn,
            torch_dtype=self.dtype,
            low_cpu_mem_usage=True,
            cache_dir="/cache/moss",
        ).to(self.device)
        self.model.eval()
        self.sample_rate = int(self.processor.model_config.sampling_rate)
        print(f"[MossWorker] Ready @ {self.sample_rate} Hz")

    @modal.method()
    def warmup(self, dummy: int = 0) -> dict:
        return {"status": "warm", "model": MOSS_MODEL_ID, "dummy": dummy}

    def _run_moss_generate(
        self,
        conversation: list,
        mode: str,
        trim_prefix_path: str | None = None,
    ) -> dict:
        import torch

        batch = self.processor(conversation, mode=mode)
        input_ids = batch["input_ids"].to(self.device)
        attention_mask = batch["attention_mask"].to(self.device)

        with torch.no_grad():
            outputs = self.model.generate(
                input_ids=input_ids,
                attention_mask=attention_mask,
                **MOSS_GEN_KWARGS,
            )

        for message in self.processor.decode(outputs):
            if message is None:
                continue
            audio = message.audio_codes_list[0]
            wav_bytes = _audio_tensor_to_mono_wav_bytes(audio, self.sample_rate)
            if trim_prefix_path:
                wav_bytes = _trim_prefix_audio(wav_bytes, trim_prefix_path)
            import soundfile as sf

            data, sr = sf.read(io.BytesIO(wav_bytes))
            duration = len(data) / sr
            return {
                "status": "success",
                "audio_base64": _audio_bytes_to_base64(wav_bytes),
                "duration_seconds": duration,
                "sample_rate": OUTPUT_SAMPLE_RATE,
            }

        return {"status": "error", "error": "MOSS decode returned no audio"}

    def _synthesize(
        self,
        text: str,
        ref_path: str,
        language: str,
        prefix_audio_path: str | None = None,
        prefix_text: str = "",
    ) -> dict:
        _preload_ffmpeg_libs()
        paced_text = apply_moss_pacing(text)

        if prefix_audio_path:
            conversation = [
                [
                    self.processor.build_user_message(
                        text=prefix_text + paced_text,
                        reference=[ref_path],
                        language=language,
                    ),
                    self.processor.build_assistant_message(audio_codes_list=[prefix_audio_path]),
                ]
            ]
            return self._run_moss_generate(
                conversation,
                mode="continuation",
                trim_prefix_path=prefix_audio_path,
            )

        conversation = [
            [
                self.processor.build_user_message(
                    text=paced_text,
                    reference=[ref_path],
                    language=language,
                )
            ]
        ]
        return self._run_moss_generate(conversation, mode="generation")

    @modal.method()
    def generate_paragraph(
        self,
        text: str,
        voice_base64: str,
        language: str = DEFAULT_LANGUAGE,
    ) -> dict:
        temp_dir = tempfile.mkdtemp(prefix="moss_para_")
        try:
            ref_path = os.path.join(temp_dir, "ref.wav")
            _write_ref_wav(voice_base64, ref_path)
            return self._synthesize(text, ref_path, language)
        except Exception as e:
            return {"status": "error", "error": str(e)}
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    @modal.method()
    def synthesize_batch(self, request_dict: dict) -> dict:
        """Synthesize one text batch; optional MOSS continuation prefix for voice anchoring."""
        batch_index = request_dict.get("batch_index", 0)
        batch_text = request_dict.get("batch_text", "")
        voice_base64 = request_dict.get("voice_base64", "")
        language = request_dict.get("moss_language", DEFAULT_LANGUAGE)
        prefix_audio_b64 = request_dict.get("prefix_audio_b64")
        prefix_text = request_dict.get("prefix_text", "")

        if not batch_text.strip():
            return {"status": "error", "batch_index": batch_index, "error": "Empty batch text"}

        temp_dir = tempfile.mkdtemp(prefix=f"moss_batch_{batch_index}_")
        try:
            ref_path = os.path.join(temp_dir, "ref.wav")
            _write_ref_wav(voice_base64, ref_path)

            prefix_audio_path = None
            if prefix_audio_b64:
                prefix_audio_path = os.path.join(temp_dir, "prefix.wav")
                with open(prefix_audio_path, "wb") as f:
                    f.write(base64.b64decode(prefix_audio_b64))

            result = self._synthesize(
                batch_text,
                ref_path,
                language,
                prefix_audio_path=prefix_audio_path,
                prefix_text=prefix_text,
            )
            result["batch_index"] = batch_index
            return result
        except Exception as e:
            return {"status": "error", "batch_index": batch_index, "error": str(e)}
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    @modal.method()
    def process_sections(self, request_dict: dict) -> dict:
        import soundfile as sf

        job_id = request_dict.get("job_id", "unknown")
        chunk_index = request_dict.get("chunk_index", 0)
        paragraphs = request_dict.get("paragraphs", [])
        voice_base64 = request_dict.get("voice_base64", "")
        webhook_url = request_dict.get("webhook_url", "")
        total_chunks = request_dict.get("total_chunks", 1)
        r2_bucket = request_dict.get("r2_bucket_name", "echomancer-audio")
        language = request_dict.get("moss_language", DEFAULT_LANGUAGE)

        if not paragraphs:
            return {"status": "error", "error": "No paragraphs provided", "chunk_index": chunk_index}

        temp_dir = tempfile.mkdtemp(prefix=f"moss_{job_id}_chunk{chunk_index}_")
        start_time = time.time()

        try:
            ref_path = os.path.join(temp_dir, "ref.wav")
            _write_ref_wav(voice_base64, ref_path)

            paragraph_files: list[str] = []
            failed_local: list[int] = []

            if MOSS_VOICE_CONSISTENCY:
                batches = _group_paragraphs_for_synthesis(paragraphs)
                prefix_audio_path: str | None = None
                prefix_text = ""
                for batch_idx, batch_paras in enumerate(batches):
                    batch_text = _join_batch_text(batch_paras)
                    if not batch_text.strip():
                        continue
                    try:
                        result = self._synthesize(
                            batch_text,
                            ref_path,
                            language,
                            prefix_audio_path=prefix_audio_path,
                            prefix_text=prefix_text,
                        )
                        if result.get("status") != "success":
                            failed_local.append(batch_idx)
                            print(
                                f"[MossWorker {job_id}] Batch {batch_idx} failed: {result.get('error')}"
                            )
                            continue
                        batch_path = os.path.join(temp_dir, f"batch_{batch_idx:04d}.wav")
                        with open(batch_path, "wb") as f:
                            f.write(base64.b64decode(result["audio_base64"]))
                        paragraph_files.append(batch_path)
                        prefix_audio_path = batch_path
                        prefix_text += batch_text
                    except Exception as e:
                        failed_local.append(batch_idx)
                        print(f"[MossWorker {job_id}] Batch {batch_idx} exception: {e}")
            else:
                for i, para_data in enumerate(paragraphs):
                    text = para_data.get("text", "")
                    if not text.strip():
                        continue
                    try:
                        result = self._synthesize(text, ref_path, language)
                        if result.get("status") != "success":
                            failed_local.append(i)
                            print(f"[MossWorker {job_id}] Para {i} failed: {result.get('error')}")
                            continue
                        para_path = os.path.join(temp_dir, f"para_{i:04d}.wav")
                        with open(para_path, "wb") as f:
                            f.write(base64.b64decode(result["audio_base64"]))
                        paragraph_files.append(para_path)
                    except Exception as e:
                        failed_local.append(i)
                        print(f"[MossWorker {job_id}] Para {i} exception: {e}")

            if not paragraph_files:
                return {"status": "error", "error": "All paragraphs failed", "chunk_index": chunk_index}

            chunk_audio_path = os.path.join(temp_dir, f"chunk_{chunk_index}.wav")
            insert_silence_between_chunks(
                paragraph_files, chunk_audio_path, silence_duration=PARAGRAPH_SILENCE
            )

            r2 = get_r2_client()
            chunk_r2_key = f"audiobooks/{job_id}/chunks/chunk_{chunk_index:03d}.wav"
            upload_to_r2(r2, r2_bucket, chunk_r2_key, chunk_audio_path, "audio/wav")

            duration = 0.0
            try:
                duration = sf.info(chunk_audio_path).duration
            except Exception:
                pass

            elapsed = time.time() - start_time
            print(
                f"[MossWorker {job_id}] Chunk {chunk_index}: "
                f"{len(paragraph_files)}/{len(paragraphs)} paras, {duration:.1f}s audio, {elapsed:.1f}s wall"
            )

            if webhook_url:
                send_webhook_async(
                    webhook_url,
                    {
                        "job_id": job_id,
                        "status": "processing",
                        "progress": 10 + int((chunk_index + 1) / max(1, total_chunks) * 60),
                        "message": f"MOSS chunk {chunk_index + 1} complete",
                    },
                )

            return {
                "status": "success",
                "chunk_index": chunk_index,
                "r2_key": chunk_r2_key,
                "duration_seconds": duration,
                "paragraphs_done": len(paragraph_files),
                "paragraphs_failed": len(failed_local),
                "elapsed_seconds": elapsed,
            }
        except Exception as e:
            traceback.print_exc()
            return {"status": "error", "chunk_index": chunk_index, "error": str(e)}
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)


@app.function(
    image=moss_gpu_image,
    gpu=GPU_CONFIG,
    memory=CONTAINER_MEMORY_MIB,
    timeout=300,
)
def debug_torchcodec() -> dict:
    import subprocess

    _preload_ffmpeg_libs()
    so = "/usr/local/lib/python3.12/site-packages/torchcodec/libtorchcodec_core7.so"
    ldd = subprocess.run(["ldd", so], capture_output=True, text=True, check=False)
    try:
        import torchcodec

        return {
            "torchcodec": torchcodec.__version__,
            "ldd": ldd.stdout[-2000:],
            "ldd_err": ldd.stderr[-500:],
        }
    except Exception as e:
        return {"error": str(e), "ldd": ldd.stdout[-2000:], "ldd_err": ldd.stderr[-500:]}


def _run_wave_parallel_synthesis(
    worker: MossAudiobookWorker,
    job_id: str,
    paragraphs: list[dict],
    voice_base64: str,
    language: str,
    webhook_url: str,
    total_paragraphs: int,
) -> list[dict]:
    """
    Wave-parallel MOSS synthesis:
      Wave 1: batch₀ solo (voice clone) → batches₁‥ₙ₋₁ parallel from batch₀ prefix
      Wave 2: batchₙ continues from batchₙ₋₁ → batchesₙ₊₁‥ parallel from batchₙ
    """
    batches = _group_paragraphs_for_synthesis(paragraphs)
    if not batches:
        raise ValueError("No synthesis batches")

    wave_size = max(1, MOSS_MAX_WORKERS)
    batch_texts = [_join_batch_text(batch) for batch in batches]
    all_results: list[dict] = []

    prefix_audio_b64: str | None = None
    prefix_text = ""

    total_batches = len(batches)
    for wave_start in range(0, total_batches, wave_size):
        wave_slice = batches[wave_start : wave_start + wave_size]
        wave_num = wave_start // wave_size + 1
        total_waves = (total_batches + wave_size - 1) // wave_size

        bridge_idx = wave_start
        bridge_text = batch_texts[bridge_idx]
        bridge_req: dict = {
            "batch_index": bridge_idx,
            "batch_text": bridge_text,
            "voice_base64": voice_base64,
            "moss_language": language,
        }
        if prefix_audio_b64:
            bridge_req["prefix_audio_b64"] = prefix_audio_b64
            bridge_req["prefix_text"] = prefix_text

        print(
            f"[Moss Job {job_id}] Wave {wave_num}/{total_waves}: "
            f"anchor batch {bridge_idx + 1}/{total_batches}"
        )
        bridge_result = worker.synthesize_batch.remote(bridge_req)
        if bridge_result.get("status") != "success":
            raise ValueError(
                f"Anchor batch {bridge_idx} failed: {bridge_result.get('error', 'unknown')}"
            )
        all_results.append(bridge_result)

        fan_requests = []
        for offset, _fan_paras in enumerate(wave_slice[1:], start=1):
            fan_idx = wave_start + offset
            fan_requests.append(
                {
                    "batch_index": fan_idx,
                    "batch_text": batch_texts[fan_idx],
                    "voice_base64": voice_base64,
                    "moss_language": language,
                    "prefix_audio_b64": bridge_result["audio_base64"],
                    "prefix_text": bridge_text,
                }
            )

        if fan_requests:
            print(
                f"[Moss Job {job_id}] Wave {wave_num}: "
                f"fan-out {len(fan_requests)} batches from anchor {bridge_idx + 1}"
            )
            fan_results = list(worker.synthesize_batch.map(fan_requests))
            failed_indices = {
                r.get("batch_index") for r in fan_results if r.get("status") != "success"
            }
            if failed_indices:
                print(f"[Moss Job {job_id}] Retrying fan batches {sorted(failed_indices)}")
                retry_reqs = [req for req in fan_requests if req["batch_index"] in failed_indices]
                retry_results = list(worker.synthesize_batch.map(retry_reqs))
                retry_by_idx = {r["batch_index"]: r for r in retry_results if r.get("status") == "success"}
                fan_results = [
                    retry_by_idx.get(r.get("batch_index"), r) if r.get("status") != "success" else r
                    for r in fan_results
                ]
            fan_ok = [r for r in fan_results if r.get("status") == "success"]
            if len(fan_ok) != len(fan_requests):
                missing = sorted(
                    set(req["batch_index"] for req in fan_requests)
                    - set(r.get("batch_index") for r in fan_ok)
                )
                raise ValueError(f"Fan batches {missing} failed after retry")
            all_results.extend(sorted(fan_ok, key=lambda x: x["batch_index"]))

        last_idx = all_results[-1]["batch_index"]
        prefix_audio_b64 = all_results[-1]["audio_base64"]
        prefix_text = batch_texts[last_idx]

        done_batches = len(all_results)
        send_webhook_async(
            webhook_url,
            {
                "job_id": job_id,
                "status": "processing",
                "progress": 10 + int(done_batches / max(1, total_batches) * 60),
                "message": f"MOSS wave {wave_num}/{total_waves} complete ({done_batches}/{total_batches} batches)",
            },
        )

    return sorted(all_results, key=lambda x: x["batch_index"])


# ── CPU orchestrator ─────────────────────────────────────────────────────────

@app.function(
    image=cpu_image,
    timeout=3600,
    secrets=[modal.Secret.from_name("echomancer-secrets")],
)
def process_audiobook(request_dict: dict) -> dict:
    job_id = request_dict.get("job_id", "unknown")
    print(f"[Moss Job {job_id}] Orchestrator STARTED")
    request = AudiobookRequest(**request_dict)
    temp_dir = tempfile.mkdtemp(prefix=f"moss_{job_id}_")

    def cleanup():
        shutil.rmtree(temp_dir, ignore_errors=True)

    try:
        r2 = get_r2_client()
        if not verify_r2_permissions(r2, request.r2_bucket_name):
            raise ValueError("R2 permissions check failed")

        text = download_and_load_book_text(
            r2, request.r2_bucket_name, request.pdf_r2_key, temp_dir
        )
        paragraph_count = len([p for p in text.split("\n\n") if p.strip()])
        print(
            f"[Moss Job {job_id}] Loaded {len(text)} characters, "
            f"{paragraph_count} paragraphs from {request.pdf_r2_key}"
        )

        voice_path = os.path.join(temp_dir, "voice_raw")
        download_from_r2(r2, request.r2_bucket_name, request.voice_r2_key, voice_path)

        clip_duration = max(3, min(MAX_REF_SECONDS, request.end_time - request.start_time))
        voice_clipped_path = os.path.join(temp_dir, "voice_clipped.wav")
        clip_audio_ffmpeg(
            voice_path,
            voice_clipped_path,
            request.start_time,
            clip_duration,
            sample_rate=OUTPUT_SAMPLE_RATE,
        )

        voice_final_path = voice_clipped_path
        audio_cleaner_url = os.environ.get("AUDIO_CLEANER_URL", "").rstrip("/")
        if audio_cleaner_url:
            try:
                import httpx

                with open(voice_clipped_path, "rb") as f:
                    voice_clipped_b64 = base64.b64encode(f.read()).decode("utf-8")
                with httpx.Client(timeout=60.0) as client:
                    response = client.post(
                        f"{audio_cleaner_url}/clean",
                        json={
                            "audio_base64": voice_clipped_b64,
                            "target_sample_rate": OUTPUT_SAMPLE_RATE,
                            "normalize_loudness": True,
                            "target_lufs": -16.0,
                        },
                    )
                if response.status_code == 200:
                    cleaned_b64 = response.json().get("audio_base64")
                    if cleaned_b64:
                        voice_cleaned_path = os.path.join(temp_dir, "voice_cleaned.wav")
                        with open(voice_cleaned_path, "wb") as f:
                            f.write(base64.b64decode(cleaned_b64))
                        voice_final_path = voice_cleaned_path
                        print(f"[Moss Job {job_id}] Voice cleaned via Audio Cleaner")
            except Exception as e:
                print(f"[Moss Job {job_id}] Audio Cleaner skipped: {e}")

        with open(voice_final_path, "rb") as f:
            voice_base64 = base64.b64encode(f.read()).decode("utf-8")

        try:
            ref_text = transcribe_with_whisper(voice_final_path, language="en")
            print(f"[Moss Job {job_id}] Voice transcript: {ref_text[:120]}...")
        except Exception as e:
            print(f"[Moss Job {job_id}] Whisper skipped: {e}")

        text = normalize_punctuation(normalize_text(text))
        paragraphs_raw = split_text_into_paragraphs(text, max_chars=MAX_PARAGRAPH_CHARS)
        paragraphs = [{"text": p} for p in paragraphs_raw]
        total_paragraphs = len(paragraphs)
        if total_paragraphs == 0:
            raise ValueError("No paragraphs found")

        synthesis_batches = _group_paragraphs_for_synthesis(paragraphs)
        print(
            f"[Moss Job {job_id}] {total_paragraphs} paragraphs, "
            f"{len(synthesis_batches)} batches, mode={MOSS_PARALLEL_MODE}, "
            f"workers={MOSS_MAX_WORKERS}, variant={_DEPLOY_VARIANT}, "
            f"language={request.moss_language}"
        )

        send_webhook_async(
            request.webhook_url,
            {
                "job_id": job_id,
                "status": "processing",
                "progress": 10,
                "current_paragraph": 0,
                "total_paragraphs": total_paragraphs,
                "message": f"Starting MOSS {MOSS_VARIANT_LABEL} ({MOSS_PARALLEL_MODE}, {MOSS_MAX_WORKERS} workers)",
            },
        )

        worker = MossAudiobookWorker()
        partial_files: list[str] = []

        if MOSS_PARALLEL_MODE == "wave":
            batch_results = _run_wave_parallel_synthesis(
                worker,
                job_id,
                paragraphs,
                voice_base64,
                request.moss_language,
                request.webhook_url,
                total_paragraphs,
            )
            for batch in batch_results:
                local_path = os.path.join(temp_dir, f"partial_{batch['batch_index']:03d}.wav")
                with open(local_path, "wb") as f:
                    f.write(base64.b64decode(batch["audio_base64"]))
                partial_files.append(local_path)
        else:
            if MOSS_PARALLEL_MODE == "sequential":
                num_chunks = 1
            else:
                num_chunks = min(total_paragraphs, MOSS_MAX_WORKERS)

            paragraphs_per_chunk = max(1, (total_paragraphs + num_chunks - 1) // num_chunks)
            chunk_requests = []
            for chunk_idx in range(num_chunks):
                start = chunk_idx * paragraphs_per_chunk
                end = min(start + paragraphs_per_chunk, total_paragraphs)
                chunk_paragraphs = paragraphs[start:end]
                if not chunk_paragraphs:
                    continue
                chunk_requests.append(
                    {
                        "job_id": job_id,
                        "chunk_index": chunk_idx,
                        "paragraphs": chunk_paragraphs,
                        "voice_base64": voice_base64,
                        "webhook_url": request.webhook_url,
                        "total_paragraphs": total_paragraphs,
                        "total_chunks": 0,
                        "r2_bucket_name": request.r2_bucket_name,
                        "moss_language": request.moss_language,
                    }
                )

            total_chunks = len(chunk_requests)
            for cr in chunk_requests:
                cr["total_chunks"] = total_chunks

            chunk_results = list(worker.process_sections.map(chunk_requests))
            successful_chunks = [r for r in chunk_results if r.get("status") == "success"]
            failed_chunks = [r for r in chunk_results if r.get("status") != "success"]

            if failed_chunks:
                print(f"[Moss Job {job_id}] Retrying {len(failed_chunks)} failed chunks")
                retry_requests = [chunk_requests[fc["chunk_index"]] for fc in failed_chunks]
                for res in worker.process_sections.map(retry_requests):
                    if res.get("status") == "success":
                        successful_chunks.append(res)

            success_indices = {c["chunk_index"] for c in successful_chunks}
            if len(success_indices) < total_chunks:
                missing = sorted(set(range(total_chunks)) - success_indices)
                raise ValueError(f"Chunks {missing} failed after retry")

            successful_chunks.sort(key=lambda x: x["chunk_index"])

            for chunk in successful_chunks:
                local_path = os.path.join(temp_dir, f"partial_{chunk['chunk_index']:03d}.wav")
                download_from_r2(r2, request.r2_bucket_name, chunk["r2_key"], local_path)
                partial_files.append(local_path)

        send_webhook_async(
            request.webhook_url,
            {
                "job_id": job_id,
                "status": "processing",
                "progress": 75,
                "message": "MOSS batches complete, concatenating...",
            },
        )

        smooth_batch_boundaries(partial_files, sample_rate=OUTPUT_SAMPLE_RATE)
        concatenated_path = os.path.join(temp_dir, "concatenated.wav")
        concatenate_audio_ffmpeg(
            partial_files,
            concatenated_path,
            crossfade_duration=batch_seam_crossfade_duration(),
        )

        final_path = os.path.join(temp_dir, "audiobook.mp3")
        normalize_audio_ffmpeg(concatenated_path, final_path, sample_rate=OUTPUT_SAMPLE_RATE)

        output_key = f"audiobooks/{job_id}/audiobook.mp3"
        upload_to_r2(r2, request.r2_bucket_name, output_key, final_path, "audio/mpeg")

        file_size = os.path.getsize(final_path)
        estimated_duration = int(file_size / 24000)

        if MOSS_PARALLEL_MODE != "wave":
            for chunk in successful_chunks:
                try:
                    r2.delete_object(Bucket=request.r2_bucket_name, Key=chunk["r2_key"])
                except Exception as e:
                    print(f"[Moss Job {job_id}] Failed to delete chunk {chunk['r2_key']}: {e}")

        send_webhook_sync(
            request.webhook_url,
            {
                "job_id": job_id,
                "status": "ready",
                "progress": 100,
                "audio_storage_path": output_key,
                "duration_seconds": estimated_duration,
                "error_message": None,
            },
        )

        return {
            "status": "success",
            "audio_storage_path": output_key,
            "duration_seconds": estimated_duration,
            "pipeline_mode": "moss",
        }

    except Exception as e:
        error_msg = str(e)
        print(f"[Moss Job {job_id}] ERROR: {error_msg}")
        traceback.print_exc()
        send_webhook_sync(
            request.webhook_url,
            {
                "job_id": job_id,
                "status": "failed",
                "progress": 0,
                "error_message": error_msg,
            },
        )
        return {"status": "failed", "error": error_msg}
    finally:
        cleanup()


# ── FastAPI ──────────────────────────────────────────────────────────────────

@app.function(image=cpu_image, timeout=1800)
@modal.asgi_app()
def fastapi_app():
    from fastapi import FastAPI, HTTPException
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse

    web_app = FastAPI(title=f"Echomancer MOSS-TTS ({MOSS_VARIANT_LABEL})")
    web_app.add_middleware(
        CORSMiddleware,
        allow_origins=["https://echomancer-v2.vercel.app"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @web_app.get("/health")
    async def health() -> JSONResponse:
        return JSONResponse(
            {
                "status": "ok",
                "pipeline": "moss",
                "variant": _DEPLOY_VARIANT,
                "model": MOSS_MODEL_ID,
                "max_workers": MOSS_MAX_WORKERS,
                "parallel_mode": MOSS_PARALLEL_MODE,
                "decode_profile": MOSS_DECODE_PROFILE,
                "batch_chars": MOSS_BATCH_CHARS,
                "voice_consistency": MOSS_VOICE_CONSISTENCY,
                "timestamp": time.time(),
            }
        )

    @web_app.post("/warmup")
    async def warmup_endpoint(request: dict) -> JSONResponse:
        try:
            n = max(1, min(request.get("containers", 2), MAX_CONTAINERS))
            worker = MossAudiobookWorker()
            results = list(worker.warmup.map(range(n)))
            return JSONResponse({"status": "warm", "containers_ready": len(results), "results": results})
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    @web_app.post("/generate_audiobook")
    async def generate_audiobook_endpoint(request: dict) -> JSONResponse:
        try:
            req = AudiobookRequest(
                job_id=request["job_id"],
                pdf_r2_key=request["pdf_r2_key"],
                voice_r2_key=request["voice_r2_key"],
                start_time=request.get("start_time", 0),
                end_time=request.get("end_time", 30),
                webhook_url=request["webhook_url"],
                book_title=request.get("book_title", "Untitled"),
                voice_name=request.get("voice_name", "Unknown"),
                r2_bucket_name=request.get("r2_bucket_name", "echomancer-audio"),
                pipeline_mode=request.get("pipeline_mode", "moss"),
                moss_language=request.get("moss_language", DEFAULT_LANGUAGE),
            )
            call = await process_audiobook.spawn.aio(req.__dict__)
            return JSONResponse(
                {
                    "status": "accepted",
                    "job_id": req.job_id,
                    "pipeline_mode": "moss",
                    "variant": _DEPLOY_VARIANT,
                    "model": MOSS_MODEL_ID,
                    "max_workers": MOSS_MAX_WORKERS,
                    "call_id": call.object_id,
                }
            )
        except Exception as e:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=str(e))

    @web_app.post("/generate_batch")
    async def generate_batch_endpoint(request: dict) -> JSONResponse:
        """Voice preview — MOSS zero-shot clone from user reference audio."""
        try:
            texts = request.get("texts") or [request.get("text", "Hello, this is a voice preview.")]
            reference_audio_base64 = request["reference_audio_base64"]
            language = request.get("moss_language", DEFAULT_LANGUAGE)

            worker = MossAudiobookWorker()
            results = []
            for text in texts:
                output = await worker.generate_paragraph.remote.aio(
                    text, reference_audio_base64, language
                )
                if output.get("status") != "success":
                    results.append(
                        {
                            "audio_base64": None,
                            "error": output.get("error"),
                            "pipeline_path": "failed",
                        }
                    )
                    continue
                results.append(
                    {
                        "audio_base64": output["audio_base64"],
                        "duration_seconds": output.get("duration_seconds", 0),
                        "error": None,
                        "pipeline_path": "moss",
                    }
                )

            return JSONResponse(
                {
                    "results": results,
                    "pipeline_mode": "moss",
                    "variant": _DEPLOY_VARIANT,
                    "model": MOSS_MODEL_ID,
                }
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    return web_app