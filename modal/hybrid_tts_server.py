"""
Hybrid TTS Server for Echomancer — Qwen Base clone + MeanVC timbre refine.

Per paragraph:
  1. Qwen3-TTS-12Hz-1.7B-Base (L4) — strong reading from reference clone prompt
  2. MeanVC (T4) — push timbre from ~70% clone toward exact user reference
  3. F5-TTS (A10G) — fallback only if Qwen clone fails

Deploy:
  modal deploy modal/hybrid_tts_server.py

Set Vercel env:
  TTS_PIPELINE_MODE=hybrid
  MODAL_HYBRID_TTS_URL=https://<user>--echomancer-hybrid-tts-fastapi-app.modal.run/generate_batch
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import traceback
from dataclasses import dataclass
from typing import List, Optional

import modal

from emotion_instruct import analyze_paragraph, paragraph_to_instruct
from tts_shared import (
    MAX_PARAGRAPH_CHARS,
    PARAGRAPH_SILENCE,
    clip_audio_ffmpeg,
    concatenate_audio_ffmpeg,
    decode_audio_base64,
    download_from_r2,
    get_r2_client,
    insert_silence_between_chunks,
    normalize_audio_ffmpeg,
    normalize_punctuation,
    normalize_text,
    send_webhook_async,
    send_webhook_sync,
    split_text_into_paragraphs,
    transcribe_with_whisper,
    upload_to_r2,
    verify_r2_permissions,
)

QWEN_MODEL_ID = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
QWEN_BASE_MODEL_ID = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
QWEN_TOKENIZER_ID = "Qwen/Qwen3-TTS-Tokenizer-12Hz"
DEFAULT_QWEN_SPEAKER = "Ryan"
DEFAULT_QWEN_LANGUAGE = "English"
TARGET_SAMPLE_RATE = 24000
NUM_CHUNKS = 4
# Lower temperature = less "generic narrator" smoothing, closer to reference timbre.
QWEN_CLONE_GEN_KWARGS = {
    "max_new_tokens": 2048,
    "do_sample": True,
    "top_k": 40,
    "top_p": 0.9,
    "temperature": 0.65,
    "repetition_penalty": 1.05,
    "subtalker_dosample": True,
    "subtalker_top_k": 40,
    "subtalker_top_p": 0.9,
    "subtalker_temperature": 0.65,
}

volume = modal.Volume.from_name("hybrid-tts-cache-v1", create_if_missing=True)

cpu_image = (
    modal.Image.debian_slim(python_version="3.11")
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
    .add_local_python_source("emotion_instruct")
    .add_local_python_source("tts_shared")
)

qwen_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libsndfile1", "git")
    .pip_install(
        "torch==2.5.1",
        "torchaudio==2.5.1",
        "transformers>=4.49",
        "accelerate",
        "huggingface-hub",
        "soundfile",
        "librosa",
        "numpy<2",
        "qwen-tts",
    )
    .run_commands(
        "python -c \"from huggingface_hub import snapshot_download; "
        f"snapshot_download('{QWEN_TOKENIZER_ID}'); "
        f"snapshot_download('{QWEN_MODEL_ID}'); "
        f"snapshot_download('{QWEN_BASE_MODEL_ID}')\"",
    )
    .add_local_python_source("emotion_instruct")
    .add_local_python_source("tts_shared")
)

meanvc_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg", "libsndfile1")
    .pip_install(
        "torch==2.5.1",
        "torchaudio==2.5.1",
        "librosa",
        "einops",
        "x-transformers",
        "tqdm",
        "PyYAML",
        "omegaconf",
        "transformers<4.49",
        "accelerate",
        "ema_pytorch",
        "soundfile",
        "numpy<2",
        "gdown",
        "huggingface-hub",
        "matplotlib",
        "wandb",
        "jiwer==3.1.0",
        "zhon",
        "zhconv",
        "encodec",
        "prefigure",
    )
    .run_commands(
        "git clone --depth 1 https://github.com/ASLP-lab/MeanVC.git /opt/MeanVC",
        # Inference only: drop trainer import chain (pulls funasr + eval deps).
        "printf '' > /opt/MeanVC/src/model/__init__.py",
        "cd /opt/MeanVC && python download_ckpt.py",
        "mkdir -p /opt/MeanVC/src/runtime/speaker_verification/ckpt",
        "gdown 1-aE1NfzpRCLxA4GUxX9ITI3F9LlbtEGP "
        "-O /opt/MeanVC/src/runtime/speaker_verification/ckpt/wavlm_large_finetune.pth",
        # Pre-cache s3prl WavLM upstream used by speaker verification.
        "python -c \"import torch; torch.hub.load('s3prl/s3prl', 'wavlm_large')\"",
    )
    .env({"MEANVC_ROOT": "/opt/MeanVC", "PYTHONPATH": "/opt/MeanVC"})
    .add_local_python_source("meanvc_wrapper")
    .add_local_python_source("emotion_instruct")
    .add_local_python_source("tts_shared")
)

f5_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg", "libsndfile1", "espeak-ng", "libespeak-ng1")
    .pip_install(
        "torch==2.5.1",
        "torchaudio==2.5.1",
        "transformers<4.49",
        "accelerate",
        "huggingface-hub",
        "soundfile",
        "librosa",
        "numpy<2",
        "git+https://github.com/SWivid/F5-TTS.git",
    )
    .add_local_python_source("emotion_instruct")
    .add_local_python_source("tts_shared")
)

app = modal.App("echomancer-hybrid-tts")


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
    pipeline_mode: str = "hybrid"
    timbre_mode: str = "qwen_clone"  # qwen_clone (default) | f5 (max voice match)
    qwen_speaker: str = DEFAULT_QWEN_SPEAKER
    qwen_language: str = DEFAULT_QWEN_LANGUAGE


def _audio_to_base64(wav, sr: int) -> str:
    import soundfile as sf

    buf = io.BytesIO()
    sf.write(buf, wav, sr, format="WAV")
    buf.seek(0)
    return base64.b64encode(buf.read()).decode("utf-8")


def _resample_to_target(wav, sr: int, target_sr: int = TARGET_SAMPLE_RATE):
    if sr == target_sr:
        return wav, sr
    import librosa

    return librosa.resample(wav, orig_sr=sr, target_sr=target_sr), target_sr


# ── GPU: Qwen CustomVoice reader ───────────────────────────────────────────

@app.cls(
    image=qwen_image,
    gpu="L4",
    scaledown_window=600,
    timeout=600,
    volumes={"/cache": volume},
    max_containers=4,
    secrets=[modal.Secret.from_name("echomancer-secrets")],
)
class QwenReader:
    model: object = None

    @modal.enter()
    def setup(self):
        import torch
        from qwen_tts import Qwen3TTSModel

        os.makedirs("/cache/qwen", exist_ok=True)
        # Ensure tokenizer weights exist before loading CustomVoice
        from qwen_tts import Qwen3TTSTokenizer

        Qwen3TTSTokenizer.from_pretrained(QWEN_TOKENIZER_ID, cache_dir="/cache/qwen")
        self.model = Qwen3TTSModel.from_pretrained(
            QWEN_MODEL_ID,
            device_map="cuda:0",
            dtype=torch.bfloat16,
            attn_implementation="sdpa",
            cache_dir="/cache/qwen",
        )
        print("[QwenReader] Model loaded")

    @modal.method()
    def warmup(self, dummy: int = 0) -> dict:
        return {"status": "warm", "model": QWEN_MODEL_ID, "dummy": dummy}

    @modal.method()
    def generate_paragraph(
        self,
        text: str,
        instruct: str,
        speaker: str = DEFAULT_QWEN_SPEAKER,
        language: str = DEFAULT_QWEN_LANGUAGE,
    ) -> dict:
        import torch

        try:
            with torch.inference_mode():
                wavs, sr = self.model.generate_custom_voice(
                    text=text,
                    language=language,
                    speaker=speaker,
                    instruct=instruct or "",
                )
            wav, sr = _resample_to_target(wavs[0], sr, TARGET_SAMPLE_RATE)
            return {
                "status": "success",
                "audio_base64": _audio_to_base64(wav, sr),
                "sample_rate": sr,
                "duration_seconds": len(wav) / sr,
            }
        except Exception as e:
            return {"status": "error", "error": str(e)}


# ── GPU: Qwen Base zero-shot voice clone (user timbre) ───────────────────────

@app.cls(
    image=qwen_image,
    gpu="L4",
    scaledown_window=600,
    timeout=600,
    volumes={"/cache": volume},
    max_containers=4,
    secrets=[modal.Secret.from_name("echomancer-secrets")],
)
class QwenVoiceCloner:
    model: object = None
    _prompt_cache_key: str = ""
    _voice_clone_prompt: object = None

    @modal.enter()
    def setup(self):
        import torch
        from qwen_tts import Qwen3TTSModel, Qwen3TTSTokenizer

        os.makedirs("/cache/qwen", exist_ok=True)
        Qwen3TTSTokenizer.from_pretrained(QWEN_TOKENIZER_ID, cache_dir="/cache/qwen")
        self.model = Qwen3TTSModel.from_pretrained(
            QWEN_BASE_MODEL_ID,
            device_map="cuda:0",
            dtype=torch.bfloat16,
            attn_implementation="sdpa",
            cache_dir="/cache/qwen",
        )
        print("[QwenVoiceCloner] Base clone model loaded")

    @modal.method()
    def warmup(self, dummy: int = 0) -> dict:
        return {"status": "warm", "model": QWEN_BASE_MODEL_ID, "dummy": dummy}

    def _ensure_prompt(self, cache_key: str, ref_wav, ref_sr: int, ref_text: str) -> None:
        if self._prompt_cache_key == cache_key and self._voice_clone_prompt is not None:
            return

        prompt_kwargs: dict = {"ref_audio": (ref_wav, ref_sr)}
        cleaned_ref_text = (ref_text or "").strip()
        if cleaned_ref_text:
            prompt_kwargs["ref_text"] = cleaned_ref_text
            prompt_kwargs["x_vector_only_mode"] = False
        else:
            prompt_kwargs["x_vector_only_mode"] = True

        self._voice_clone_prompt = self.model.create_voice_clone_prompt(**prompt_kwargs)
        self._prompt_cache_key = cache_key

    @modal.method()
    def generate_paragraph(
        self,
        text: str,
        language: str,
        voice_base64: str,
        ref_text: str,
        cache_key: str,
    ) -> dict:
        import torch

        try:
            ref_wav, ref_sr = decode_audio_base64(voice_base64)
            self._ensure_prompt(cache_key, ref_wav, ref_sr, ref_text)

            with torch.inference_mode():
                wavs, sr = self.model.generate_voice_clone(
                    text=text,
                    language=language,
                    voice_clone_prompt=self._voice_clone_prompt,
                    **QWEN_CLONE_GEN_KWARGS,
                )
            wav, sr = _resample_to_target(wavs[0], sr, TARGET_SAMPLE_RATE)
            return {
                "status": "success",
                "audio_base64": _audio_to_base64(wav, sr),
                "sample_rate": sr,
                "duration_seconds": len(wav) / sr,
            }
        except Exception as e:
            traceback.print_exc()
            return {"status": "error", "error": str(e)}


# ── GPU: MeanVC timbre transfer ──────────────────────────────────────────────

@app.cls(
    image=meanvc_image,
    gpu="T4",
    scaledown_window=600,
    timeout=600,
    volumes={"/cache": volume},
    max_containers=4,
    secrets=[modal.Secret.from_name("echomancer-secrets")],
)
class MeanVCConverter:
    runtime: object = None

    @modal.enter()
    def setup(self):
        from meanvc_wrapper import MeanVCRuntime

        self.runtime = MeanVCRuntime(device="cuda")
        print("[MeanVCConverter] Model loaded")

    @modal.method()
    def warmup(self, dummy: int = 0) -> dict:
        return {"status": "warm", "dummy": dummy}

    @modal.method()
    def convert(
        self,
        source_audio_base64: str,
        source_sr: int,
        ref_audio_base64: str,
        ref_sr: int,
    ) -> dict:
        import soundfile as sf

        try:
            source_wav, source_sr_actual = decode_audio_base64(source_audio_base64)
            ref_wav, ref_sr_actual = decode_audio_base64(ref_audio_base64)

            converted, out_sr = self.runtime.convert_arrays(
                source_wav, source_sr_actual, ref_wav, ref_sr_actual
            )
            converted, out_sr = _resample_to_target(converted, out_sr, TARGET_SAMPLE_RATE)
            return {
                "status": "success",
                "audio_base64": _audio_to_base64(converted, out_sr),
                "sample_rate": out_sr,
                "duration_seconds": len(converted) / out_sr,
            }
        except Exception as e:
            traceback.print_exc()
            return {"status": "error", "error": str(e)}


# ── GPU: F5 fallback (paragraph-level) ───────────────────────────────────────

@app.cls(
    image=f5_image,
    gpu="A10G",
    scaledown_window=300,
    timeout=300,
    volumes={"/cache": volume},
    max_containers=2,
    secrets=[modal.Secret.from_name("echomancer-secrets"), modal.Secret.from_name("echomancer-f5-tts")],
)
class F5FallbackWorker:
    model: object = None

    @modal.enter()
    def setup(self):
        from f5_tts.api import F5TTS

        os.makedirs("/cache/models", exist_ok=True)
        self.model = F5TTS(
            model="F5TTS_v1_Base",
            device="cuda",
            hf_cache_dir="/cache/models",
        )
        print("[F5Fallback] Model loaded")

    @modal.method()
    def generate_paragraph(
        self,
        text: str,
        speed: float,
        cfg_strength: float,
        voice_base64: str,
    ) -> dict:
        import soundfile as sf
        import torch

        temp_dir = tempfile.mkdtemp(prefix="f5_fallback_")
        try:
            ref_audio, ref_sr = decode_audio_base64(voice_base64)
            max_samples = int(15 * ref_sr)
            if len(ref_audio) > max_samples:
                start = (len(ref_audio) - max_samples) // 2
                ref_audio = ref_audio[start : start + max_samples]

            ref_path = os.path.join(temp_dir, "ref.wav")
            sf.write(ref_path, ref_audio, ref_sr)

            with torch.inference_mode():
                wav, sr, _ = self.model.infer(
                    ref_file=ref_path,
                    ref_text="",
                    gen_text=text,
                    nfe_step=32,
                    cfg_strength=cfg_strength,
                    speed=speed,
                )
            wav, sr = _resample_to_target(wav, sr, TARGET_SAMPLE_RATE)
            return {
                "status": "success",
                "audio_base64": _audio_to_base64(wav, sr),
                "sample_rate": sr,
                "duration_seconds": len(wav) / sr,
                "fallback": "f5",
            }
        except Exception as e:
            return {"status": "error", "error": str(e)}
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)


# ── CPU/GPU-light chunk worker ─────────────────────────────────────────────

@app.cls(
    image=cpu_image,
    cpu=2,
    memory=4096,
    scaledown_window=600,
    timeout=900,
    secrets=[modal.Secret.from_name("echomancer-secrets")],
    max_containers=4,
)
class HybridAudiobookWorker:
    @modal.method()
    def warmup(self, dummy: int = 0) -> dict:
        cloner = QwenVoiceCloner()
        list(cloner.warmup.map([dummy]))
        return {"status": "warm", "dummy": dummy}

    @modal.method()
    def process_sections(self, request_dict: dict) -> dict:
        import soundfile as sf

        job_id = request_dict.get("job_id", "unknown")
        chunk_index = request_dict.get("chunk_index", 0)
        paragraphs = request_dict.get("paragraphs", [])
        voice_base64 = request_dict.get("voice_base64", "")
        webhook_url = request_dict.get("webhook_url", "")
        r2_bucket = request_dict.get("r2_bucket_name", "echomancer-audio")
        qwen_language = request_dict.get("qwen_language", DEFAULT_QWEN_LANGUAGE)
        ref_text = request_dict.get("ref_text", "")

        if not paragraphs:
            return {"status": "error", "error": "No paragraphs provided", "chunk_index": chunk_index}

        timbre_mode = request_dict.get("timbre_mode", "qwen_clone")
        cloner = QwenVoiceCloner()
        f5 = F5FallbackWorker()
        prompt_cache_key = f"{job_id}:{hash(voice_base64) & 0xFFFFFFFF:x}"

        temp_dir = tempfile.mkdtemp(prefix=f"hybrid_{job_id}_chunk{chunk_index}_")
        start_time = time.time()
        paragraph_files = []
        failed_local = []
        fallback_count = 0
        pipeline_info = []

        try:
            ref_audio, ref_sr = decode_audio_base64(voice_base64)
            ref_path = os.path.join(temp_dir, "ref.wav")
            sf.write(ref_path, ref_audio, ref_sr)

            for i, para_data in enumerate(paragraphs):
                text = para_data.get("text", "")
                speed = para_data.get("speed", 0.88)
                cfg_strength = para_data.get("cfg_strength", 2.0)
                instruct = para_data.get("instruct") or paragraph_to_instruct(text, speed, cfg_strength)

                if not text.strip():
                    continue

                try:
                    if timbre_mode == "f5":
                        converted = f5.generate_paragraph.remote(
                            text, speed, cfg_strength, voice_base64
                        )
                        if converted.get("status") != "success":
                            raise RuntimeError(converted.get("error", "F5 generation failed"))
                        pipeline_info.append("f5")
                    else:
                        clone = cloner.generate_paragraph.remote(
                            text,
                            qwen_language,
                            voice_base64,
                            ref_text,
                            prompt_cache_key,
                        )
                        if clone.get("status") != "success":
                            print(
                                f"[Hybrid {job_id}] Qwen clone failed para {i}: "
                                f"{clone.get('error')}, falling back to F5"
                            )
                            converted = f5.generate_paragraph.remote(
                                text, speed, cfg_strength, voice_base64
                            )
                            if converted.get("status") != "success":
                                raise RuntimeError(converted.get("error", "F5 fallback failed"))
                            fallback_count += 1
                            pipeline_info.append("f5_fallback")
                        else:
                            converted = clone
                            pipeline_info.append("qwen_clone")

                    audio_bytes = base64.b64decode(converted["audio_base64"])
                    para_path = os.path.join(temp_dir, f"para_{i:04d}.wav")
                    with open(para_path, "wb") as f:
                        f.write(audio_bytes)
                    paragraph_files.append(para_path)

                except Exception as e:
                    print(f"[Hybrid {job_id}] Paragraph {i} failed: {e}")
                    failed_local.append(i)

            if not paragraph_files:
                return {"status": "error", "error": "All paragraphs failed", "chunk_index": chunk_index}

            chunk_audio_path = os.path.join(temp_dir, f"chunk_{chunk_index}.wav")
            insert_silence_between_chunks(paragraph_files, chunk_audio_path, silence_duration=PARAGRAPH_SILENCE)

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
                f"[Hybrid {job_id}] Chunk {chunk_index}: {len(paragraph_files)}/{len(paragraphs)} "
                f"paragraphs, f5_fallback={fallback_count}, {duration:.1f}s audio, {elapsed:.1f}s wall"
            )

            if webhook_url:
                send_webhook_async(
                    webhook_url,
                    {
                        "job_id": job_id,
                        "status": "processing",
                        "progress": 10
                        + int(
                            (chunk_index + 1)
                            / max(1, request_dict.get("total_chunks", 1))
                            * 60
                        ),
                        "message": f"Hybrid chunk {chunk_index + 1} complete",
                    },
                )

            return {
                "status": "success",
                "chunk_index": chunk_index,
                "r2_key": chunk_r2_key,
                "duration_seconds": duration,
                "paragraphs_done": len(paragraph_files),
                "paragraphs_failed": len(failed_local),
                "f5_fallback_count": fallback_count,
                "pipeline_paths": pipeline_info,
                "elapsed_seconds": elapsed,
            }

        except Exception as e:
            traceback.print_exc()
            return {"status": "error", "chunk_index": chunk_index, "error": str(e)}
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)


# ── Orchestrator ───────────────────────────────────────────────────────────

@app.function(
    image=cpu_image,
    scaledown_window=300,
    timeout=3600,
    volumes={"/cache": volume},
    secrets=[modal.Secret.from_name("echomancer-secrets")],
)
def process_audiobook(request_dict: dict) -> dict:
    """Download assets, split text, farm hybrid chunks, concatenate, upload."""
    import fitz

    job_id = request_dict.get("job_id", "unknown")
    print(f"[Hybrid Job {job_id}] Orchestrator STARTED")

    request = AudiobookRequest(**request_dict)
    temp_dir = tempfile.mkdtemp(prefix=f"hybrid_{job_id}_")

    def cleanup():
        shutil.rmtree(temp_dir, ignore_errors=True)

    try:
        r2 = get_r2_client()
        if not verify_r2_permissions(r2, request.r2_bucket_name):
            raise ValueError("R2 permissions check failed")

        pdf_path = os.path.join(temp_dir, "input.pdf")
        download_from_r2(r2, request.r2_bucket_name, request.pdf_r2_key, pdf_path)

        doc = fitz.open(pdf_path)
        if doc.is_encrypted or doc.needs_pass:
            doc.close()
            raise ValueError("PDF is encrypted or password-protected")
        raw_text = "".join(page.get_text() for page in doc)
        doc.close()
        if not raw_text.strip():
            raise ValueError("Could not extract text from PDF")

        text = re.sub(r"\s+", " ", raw_text).strip()
        print(f"[Hybrid Job {job_id}] Extracted {len(text)} characters")

        voice_path = os.path.join(temp_dir, "voice_raw")
        download_from_r2(r2, request.r2_bucket_name, request.voice_r2_key, voice_path)

        clip_duration = request.end_time - request.start_time
        clip_duration = max(3, min(60, clip_duration))
        voice_clipped_path = os.path.join(temp_dir, "voice_clipped.wav")
        clip_audio_ffmpeg(voice_path, voice_clipped_path, request.start_time, clip_duration)

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
                            "target_sample_rate": TARGET_SAMPLE_RATE,
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
                        print(f"[Hybrid Job {job_id}] Voice cleaned via Audio Cleaner")
            except Exception as e:
                print(f"[Hybrid Job {job_id}] Audio Cleaner skipped: {e}")

        with open(voice_final_path, "rb") as f:
            voice_base64 = base64.b64encode(f.read()).decode("utf-8")

        ref_text = ""
        try:
            ref_text = transcribe_with_whisper(voice_final_path, language=request.qwen_language.lower())
            print(f"[Hybrid Job {job_id}] Voice transcript: {ref_text[:120]}...")
        except Exception as e:
            print(f"[Hybrid Job {job_id}] Whisper skipped, using x-vector clone: {e}")

        text = normalize_punctuation(normalize_text(text))
        paragraphs_raw = split_text_into_paragraphs(text, max_chars=MAX_PARAGRAPH_CHARS)
        paragraphs = []
        for para_text in paragraphs_raw:
            speed, cfg_strength = analyze_paragraph(para_text)
            paragraphs.append(
                {
                    "text": para_text,
                    "speed": speed,
                    "cfg_strength": cfg_strength,
                    "instruct": paragraph_to_instruct(para_text, speed, cfg_strength),
                }
            )

        total_paragraphs = len(paragraphs)
        if total_paragraphs == 0:
            raise ValueError("No paragraphs found")

        print(f"[Hybrid Job {job_id}] {total_paragraphs} paragraphs, speaker={request.qwen_speaker}")

        paragraphs_per_chunk = max(1, (total_paragraphs + NUM_CHUNKS - 1) // NUM_CHUNKS)
        chunk_requests = []
        for chunk_idx in range(NUM_CHUNKS):
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
                    "ref_text": ref_text,
                    "webhook_url": request.webhook_url,
                    "total_paragraphs": total_paragraphs,
                    "total_chunks": 0,
                    "r2_bucket_name": request.r2_bucket_name,
                    "qwen_language": request.qwen_language,
                    "timbre_mode": request.timbre_mode,
                }
            )

        total_chunks = len(chunk_requests)
        for cr in chunk_requests:
            cr["total_chunks"] = total_chunks

        send_webhook_async(
            request.webhook_url,
            {
                "job_id": job_id,
                "status": "processing",
                "progress": 10,
                "current_paragraph": 0,
                "total_paragraphs": total_paragraphs,
                "message": f"Starting hybrid generation ({total_chunks} chunks)",
            },
        )

        worker = HybridAudiobookWorker()
        chunk_results = list(worker.process_sections.map(chunk_requests))

        successful_chunks = []
        failed_chunks = []
        for res in chunk_results:
            if res.get("status") == "success":
                successful_chunks.append(res)
            else:
                failed_chunks.append(res)

        if failed_chunks:
            print(f"[Hybrid Job {job_id}] Retrying {len(failed_chunks)} failed chunks")
            retry_requests = [chunk_requests[fc["chunk_index"]] for fc in failed_chunks]
            for res in worker.process_sections.map(retry_requests):
                if res.get("status") == "success":
                    successful_chunks.append(res)

        success_indices = {c["chunk_index"] for c in successful_chunks}
        if len(success_indices) < total_chunks:
            missing = sorted(set(range(total_chunks)) - success_indices)
            raise ValueError(f"Chunks {missing} failed after retry")

        successful_chunks.sort(key=lambda x: x["chunk_index"])

        send_webhook_async(
            request.webhook_url,
            {
                "job_id": job_id,
                "status": "processing",
                "progress": 75,
                "message": "Hybrid chunks complete, concatenating...",
            },
        )

        partial_files = []
        for chunk in successful_chunks:
            local_path = os.path.join(temp_dir, f"partial_{chunk['chunk_index']:03d}.wav")
            download_from_r2(r2, request.r2_bucket_name, chunk["r2_key"], local_path)
            partial_files.append(local_path)

        concatenated_path = os.path.join(temp_dir, "concatenated.wav")
        concatenate_audio_ffmpeg(partial_files, concatenated_path)

        final_path = os.path.join(temp_dir, "audiobook.mp3")
        normalize_audio_ffmpeg(concatenated_path, final_path)

        output_key = f"audiobooks/{job_id}/audiobook.mp3"
        upload_to_r2(r2, request.r2_bucket_name, output_key, final_path, "audio/mpeg")

        file_size = os.path.getsize(final_path)
        estimated_duration = int(file_size / 24000)

        for chunk in successful_chunks:
            try:
                r2.delete_object(Bucket=request.r2_bucket_name, Key=chunk["r2_key"])
            except Exception as e:
                print(f"[Hybrid Job {job_id}] Failed to delete chunk {chunk['r2_key']}: {e}")

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
            "pipeline_mode": "hybrid",
        }

    except Exception as e:
        error_msg = str(e)
        print(f"[Hybrid Job {job_id}] ERROR: {error_msg}")
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


# ── FastAPI endpoint (imports lazy — GPU images don't need fastapi) ────────

@app.function(image=cpu_image, timeout=1800)
@modal.asgi_app()
def fastapi_app():
    from fastapi import FastAPI, HTTPException
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse

    web_app = FastAPI(title="Echomancer Hybrid TTS")
    web_app.add_middleware(
        CORSMiddleware,
        allow_origins=["https://echomancer-v2.vercel.app"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    @web_app.get("/health")
    async def health() -> JSONResponse:
        return JSONResponse(
            {"status": "ok", "pipeline": "qwen_clone", "timestamp": time.time()}
        )

    @web_app.post("/warmup")
    async def warmup_endpoint(request: dict) -> JSONResponse:
        try:
            n = max(1, min(request.get("containers", 4), 4))
            worker = HybridAudiobookWorker()
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
                pipeline_mode=request.get("pipeline_mode", "hybrid"),
                timbre_mode=request.get("timbre_mode", "qwen_clone"),
                qwen_speaker=request.get("qwen_speaker", DEFAULT_QWEN_SPEAKER),
                qwen_language=request.get("qwen_language", DEFAULT_QWEN_LANGUAGE),
            )
            call = await process_audiobook.spawn.aio(req.__dict__)
            return JSONResponse(
                {
                    "status": "accepted",
                    "job_id": req.job_id,
                    "pipeline_mode": "hybrid",
                    "timbre_mode": req.timbre_mode,
                    "call_id": call.object_id,
                }
            )
        except Exception as e:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=str(e))

    @web_app.post("/generate_batch")
    async def generate_batch_endpoint(request: dict) -> JSONResponse:
        """Voice preview via Qwen Base clone from user reference audio."""
        try:
            texts = request.get("texts") or [request.get("text", "Hello, this is a voice preview.")]
            reference_audio_base64 = request["reference_audio_base64"]
            language = request.get("qwen_language", DEFAULT_QWEN_LANGUAGE)

            timbre_mode = request.get("timbre_mode", "qwen_clone")
            cloner = QwenVoiceCloner()
            f5 = F5FallbackWorker()

            voice_b64 = reference_audio_base64
            ref_wav, ref_sr = decode_audio_base64(reference_audio_base64)
            ref_text = request.get("ref_text", "")
            if timbre_mode != "f5" and not ref_text:
                import soundfile as sf

                ref_tmp = tempfile.mkdtemp(prefix="hybrid_ref_tx_")
                try:
                    ref_path = os.path.join(ref_tmp, "ref.wav")
                    sf.write(ref_path, ref_wav, ref_sr)
                    ref_text = transcribe_with_whisper(ref_path, language=language.lower())
                except Exception as e:
                    print(f"[generate_batch] Whisper skipped: {e}")
                finally:
                    shutil.rmtree(ref_tmp, ignore_errors=True)

            prompt_cache_key = f"batch:{hash(voice_b64) & 0xFFFFFFFF:x}"
            results = []
            for text in texts:
                pipeline_path = "qwen_clone"
                clone_error = None
                if timbre_mode == "f5":
                    output = await f5.generate_paragraph.remote.aio(text, 0.88, 2.0, voice_b64)
                    pipeline_path = "f5"
                    if output.get("status") != "success":
                        results.append(
                            {
                                "audio_base64": None,
                                "error": output.get("error"),
                                "pipeline_path": "failed",
                            }
                        )
                        continue
                else:
                    clone = await cloner.generate_paragraph.remote.aio(
                        text,
                        language,
                        voice_b64,
                        ref_text,
                        prompt_cache_key,
                    )
                    output = clone
                    if clone.get("status") != "success":
                        clone_error = clone.get("error")
                        print(f"[generate_batch] Qwen clone failed, falling back to F5: {clone_error}")
                        fb = await f5.generate_paragraph.remote.aio(text, 0.88, 2.0, voice_b64)
                        if fb.get("status") == "success":
                            output = fb
                            pipeline_path = "f5_fallback"
                        else:
                            results.append(
                                {
                                    "audio_base64": None,
                                    "error": clone.get("error"),
                                    "pipeline_path": "failed",
                                    "clone_error": clone_error,
                                }
                            )
                            continue

                results.append(
                    {
                        "audio_base64": output["audio_base64"],
                        "duration_seconds": output.get("duration_seconds", 0),
                        "error": None,
                        "pipeline_path": pipeline_path,
                        "clone_error": clone_error,
                    }
                )

            return JSONResponse({"results": results, "pipeline_mode": timbre_mode})
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    return web_app