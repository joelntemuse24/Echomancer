"""Isolated full-C++ MOSS-TTS-v1.5 Q8 benchmark on Modal L4."""

import base64
import hashlib
import hmac
import io
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import time
import traceback
import wave
from dataclasses import dataclass
from pathlib import Path

import modal

APP_NAME = "echomancer-openmoss-tts"
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
OUTPUT_SAMPLE_RATE = 24000
MAX_WORKERS = int(os.environ.get("OPENMOSS_MAX_WORKERS", "5"))

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
        "ffmpeg",
        "git",
        "libsndfile1",
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
    .pip_install(
        "boto3",
        "fastapi",
        "httpx",
        "huggingface_hub",
        "num2words",
        "numpy<2",
        "pymupdf",
        "soundfile",
        "uvicorn",
    )
    .env(
        {
            "LD_LIBRARY_PATH": (
                "/opt/openmoss/build/third_party/llama.cpp/bin:"
                "/opt/openmoss/build/bin:/usr/local/cuda/lib64:"
                "/usr/local/nvidia/lib:/usr/local/nvidia/lib64"
            )
        }
    )
    .add_local_python_source("tts_shared")
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
    max_containers=MAX_WORKERS,
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

    def _generate(
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
        with wave.open(io.BytesIO(response.content), "rb") as wav_file:
            duration_seconds = wav_file.getnframes() / wav_file.getframerate()
        return {
            "status": "success",
            "audio_base64": base64.b64encode(response.content).decode(),
            "duration_seconds": duration_seconds,
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
        return self._generate(
            text,
            reference_wav_base64,
            language,
            seed,
            audio_temperature,
            audio_top_p,
            audio_top_k,
            audio_repetition_penalty,
        )

    @modal.method()
    def generate_unit(self, request: dict) -> dict:
        try:
            result = self._generate(
                request["text"],
                request["reference_wav_base64"],
                request.get("language", "English"),
                request.get("seed", 42),
                request.get("audio_temperature", 1.7),
                request.get("audio_top_p", 0.8),
                request.get("audio_top_k", 25),
                request.get("audio_repetition_penalty", 1.0),
            )
            result["index"] = request["index"]
            return result
        except Exception as exc:
            return {
                "status": "error",
                "index": request.get("index", -1),
                "error": str(exc),
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
    tts_variant: str = "openmoss"
    moss_language: str = "English"
    reference_segments: list[dict] | None = None
    style_selection_seed: int = 42
    synthesis_contract: str = "openmoss-q8-sentence-v1"
    narration_instructions: str = ""
    paragraph_pause_sec: float = 0.65
    sentence_pause_sec: float = 0.22
    audio_temperature: float = 1.7
    audio_top_p: float = 0.8
    audio_top_k: int = 25
    audio_repetition_penalty: float = 1.0


def _select_style(text: str, available: set[str]) -> str:
    lowered = text.lower()
    if "dialogue" in available and re.search(r"[\"“”]", text):
        return "dialogue"
    if "animated" in available and ("!" in text or any(
        word in lowered for word in ("shouted", "raced", "suddenly", "laughed")
    )):
        return "animated"
    if "soft" in available and any(
        word in lowered for word in ("whisper", "gentle", "quiet", "tender")
    ):
        return "soft"
    if "serious" in available and any(
        word in lowered for word in ("war", "death", "law", "evidence", "warning")
    ):
        return "serious"
    return "neutral" if "neutral" in available else sorted(available)[0]


def _unit_seed(base_seed: int, index: int, label: str, text: str) -> int:
    digest = hashlib.sha256(
        f"openmoss-sentence-v1\0{base_seed}\0{index}\0{label}\0{text}".encode()
    ).digest()
    return int.from_bytes(digest[:8], "big") & 0x7FFF_FFFF


def _make_composite_reference(
    anchor_path: str,
    style_path: str,
    output_path: str,
) -> None:
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", anchor_path,
            "-i", style_path,
            "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[out]",
            "-map", "[out]",
            "-ac", "1",
            "-ar", str(OUTPUT_SAMPLE_RATE),
            output_path,
        ],
        check=True,
        capture_output=True,
        text=True,
    )


def _media_duration(path: str) -> float:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", path,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(result.stdout.strip())


@app.function(
    image=runtime_image,
    cpu=2,
    memory=8192,
    timeout=86400,
    volumes={"/models": model_read_volume},
    secrets=[modal.Secret.from_name("echomancer-secrets")],
)
def process_audiobook(request_dict: dict) -> dict:
    import numpy as np
    import soundfile as sf
    from tts_shared import (
        download_and_load_book_text,
        download_from_r2,
        get_r2_client,
        normalize_audio_ffmpeg,
        normalize_punctuation,
        normalize_text,
        send_webhook_async,
        send_webhook_sync,
        split_text_into_sentence_units,
        upload_to_r2,
        verify_r2_permissions,
    )

    request = AudiobookRequest(**request_dict)
    temp_dir = tempfile.mkdtemp(prefix=f"openmoss_{request.job_id}_")
    progress = 0
    try:
        r2 = get_r2_client()
        if not verify_r2_permissions(r2, request.r2_bucket_name):
            raise RuntimeError("R2 permissions check failed")

        text = download_and_load_book_text(
            r2,
            request.r2_bucket_name,
            request.pdf_r2_key,
            temp_dir,
        )
        text = normalize_punctuation(normalize_text(text))
        units = split_text_into_sentence_units(text)
        if not units:
            raise ValueError("No sentence units found")

        source_path = os.path.join(temp_dir, "voice_source")
        download_from_r2(
            r2, request.r2_bucket_name, request.voice_r2_key, source_path
        )
        segments = request.reference_segments or [
            {
                "label": "neutral",
                "start_time": request.start_time,
                "end_time": request.end_time,
            }
        ]
        if not 1 <= len(segments) <= 5:
            raise ValueError("Reference segment count must be between 1 and 5")
        allowed_labels = {"neutral", "animated", "soft", "serious", "dialogue"}
        labels = {str(segment["label"]).lower() for segment in segments}
        if not labels.issubset(allowed_labels) or "neutral" not in labels:
            raise ValueError("Reference styles must include neutral and use known labels")
        if len(labels) != len(segments):
            raise ValueError("Reference segment labels must be unique")
        for segment in segments:
            start = float(segment["start_time"])
            end = float(segment["end_time"])
            if (
                not math.isfinite(start)
                or not math.isfinite(end)
                or start < 0
                or end - start < 3
                or end - start > 30
            ):
                raise ValueError(
                    f"Invalid duration for {str(segment['label']).lower()} reference"
                )

        neutral = next(
            (
                segment
                for segment in segments
                if str(segment["label"]).lower() == "neutral"
            ),
            segments[0],
        )
        anchor_path = os.path.join(temp_dir, "identity_anchor.wav")
        anchor_duration = min(6.0, float(neutral["end_time"]) - float(neutral["start_time"]))
        if anchor_duration < 3:
            raise ValueError("Neutral identity clip must be at least 3 seconds")
        subprocess.run(
            [
                "ffmpeg", "-y", "-i", source_path,
                "-ss", str(neutral["start_time"]),
                "-t", str(anchor_duration),
                "-ac", "1", "-ar", str(OUTPUT_SAMPLE_RATE), anchor_path,
            ],
            check=True,
            capture_output=True,
            text=True,
        )

        references: dict[str, str] = {}
        for segment in segments:
            label = str(segment["label"]).lower()
            start_time = float(segment["start_time"])
            end_time = float(segment["end_time"])
            duration = end_time - start_time
            if (
                not math.isfinite(start_time)
                or not math.isfinite(end_time)
                or start_time < 0
                or duration < 3
                or duration > 30
            ):
                raise ValueError(f"Invalid duration for {label} reference")
            style_path = os.path.join(temp_dir, f"{label}_style.wav")
            subprocess.run(
                [
                    "ffmpeg", "-y", "-i", source_path,
                    "-ss", str(start_time),
                    "-t", str(min(duration, 12.0)),
                    "-ac", "1", "-ar", str(OUTPUT_SAMPLE_RATE), style_path,
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            reference_path = anchor_path
            if label != "neutral":
                reference_path = os.path.join(temp_dir, f"{label}_reference.wav")
                _make_composite_reference(anchor_path, style_path, reference_path)
            references[label] = base64.b64encode(
                Path(reference_path).read_bytes()
            ).decode()

        plan = []
        for index, unit in enumerate(units):
            label = _select_style(unit["text"], set(references))
            plan.append(
                {
                    **unit,
                    "index": index,
                    "reference_label": label,
                    "seed": _unit_seed(
                        request.style_selection_seed,
                        index,
                        label,
                        unit["text"],
                    ),
                }
            )
        plan_hash = hashlib.sha256(
            json.dumps(
                {
                    "contract": request.synthesis_contract,
                    "segments": segments,
                    "plan": plan,
                    "model": MODEL_REVISION,
                    "openmoss_commit": OPENMOSS_COMMIT,
                    "model_sha256": MODEL_SHA256,
                    "extras_sha256": EXTRAS_SHA256,
                    "language": request.moss_language,
                    "sampling": {
                        "temperature": request.audio_temperature,
                        "top_p": request.audio_top_p,
                        "top_k": request.audio_top_k,
                        "repetition_penalty": request.audio_repetition_penalty,
                    },
                    "pauses": {
                        "sentence": request.sentence_pause_sec,
                        "paragraph": request.paragraph_pause_sec,
                    },
                    "voice_r2_key": request.voice_r2_key,
                },
                sort_keys=True,
            ).encode()
        ).hexdigest()[:20]

        progress = 10
        webhook_delivered = send_webhook_sync(
            request.webhook_url,
            {
                "job_id": request.job_id,
                "status": "processing",
                "progress": progress,
                "current_section": 0,
                "total_sections": len(plan),
            },
        )

        sentence_dir = os.path.join(temp_dir, "sentences")
        os.makedirs(sentence_dir, exist_ok=True)
        sentence_paths: dict[int, str] = {}
        missing_requests = []
        for unit in plan:
            key = (
                f"audiobooks/{request.job_id}/checkpoints/"
                f"{request.synthesis_contract}/{plan_hash}/"
                f"sentence_{unit['index']:06d}.wav"
            )
            local_path = os.path.join(
                sentence_dir, f"sentence_{unit['index']:06d}.wav"
            )
            try:
                r2.head_object(Bucket=request.r2_bucket_name, Key=key)
                download_from_r2(r2, request.r2_bucket_name, key, local_path)
                sentence_paths[unit["index"]] = local_path
            except Exception:
                missing_requests.append(
                    {
                        "index": unit["index"],
                        "text": unit["text"],
                        "reference_wav_base64": references[unit["reference_label"]],
                        "language": request.moss_language,
                        "seed": unit["seed"],
                        "audio_temperature": request.audio_temperature,
                        "audio_top_p": request.audio_top_p,
                        "audio_top_k": request.audio_top_k,
                        "audio_repetition_penalty": request.audio_repetition_penalty,
                    }
                )

        worker = OpenMossWorker()
        completed = len(sentence_paths)
        request_by_index = {
            int(item["index"]): item for item in missing_requests
        }
        for result in worker.generate_unit.map(
            missing_requests, order_outputs=False
        ):
            index = int(result["index"])
            if result.get("status") != "success":
                result = worker.generate_unit.remote(request_by_index[index])
            if result.get("status") != "success":
                raise RuntimeError(
                    f"Sentence {index} failed: {result.get('error', 'unknown')}"
                )
            local_path = os.path.join(sentence_dir, f"sentence_{index:06d}.wav")
            Path(local_path).write_bytes(base64.b64decode(result["audio_base64"]))
            checkpoint_key = (
                f"audiobooks/{request.job_id}/checkpoints/"
                f"{request.synthesis_contract}/{plan_hash}/"
                f"sentence_{index:06d}.wav"
            )
            upload_to_r2(
                r2,
                request.r2_bucket_name,
                checkpoint_key,
                local_path,
                "audio/wav",
            )
            sentence_paths[index] = local_path
            completed += 1
            if completed == len(plan) or completed % 10 == 0:
                progress = 10 + int(completed / len(plan) * 75)
                send_webhook_async(
                    request.webhook_url,
                    {
                        "job_id": request.job_id,
                        "status": "processing",
                        "progress": progress,
                        "current_section": completed,
                        "total_sections": len(plan),
                    },
                )

        if len(sentence_paths) != len(plan):
            raise RuntimeError("Not all sentence checkpoints completed")

        arrays = []
        for unit in plan:
            audio, sample_rate = sf.read(
                sentence_paths[unit["index"]], dtype="float32"
            )
            if sample_rate != OUTPUT_SAMPLE_RATE:
                raise RuntimeError("Sentence checkpoint sample rate mismatch")
            if audio.ndim > 1:
                audio = audio.mean(axis=1)
            arrays.append(audio)
            pause = (
                request.paragraph_pause_sec
                if unit["ends_paragraph"]
                else request.sentence_pause_sec
            )
            arrays.append(np.zeros(int(pause * OUTPUT_SAMPLE_RATE), dtype=np.float32))

        assembled_path = os.path.join(temp_dir, "assembled.wav")
        sf.write(
            assembled_path,
            np.concatenate(arrays),
            OUTPUT_SAMPLE_RATE,
            subtype="PCM_16",
        )
        progress = 90
        send_webhook_async(
            request.webhook_url,
            {
                "job_id": request.job_id,
                "status": "processing",
                "progress": progress,
                "current_section": len(plan),
                "total_sections": len(plan),
            },
        )

        final_path = os.path.join(temp_dir, "audiobook.mp3")
        normalize_audio_ffmpeg(
            assembled_path, final_path, sample_rate=OUTPUT_SAMPLE_RATE
        )
        output_key = f"audiobooks/{request.job_id}/audiobook.mp3"
        upload_to_r2(
            r2, request.r2_bucket_name, output_key, final_path, "audio/mpeg"
        )
        duration = _media_duration(final_path)
        send_webhook_sync(
            request.webhook_url,
            {
                "job_id": request.job_id,
                "status": "ready",
                "progress": 100,
                "current_section": len(plan),
                "total_sections": len(plan),
                "audio_storage_path": output_key,
                "duration_seconds": duration,
                "error_message": None,
            },
        )
        if webhook_delivered:
            checkpoint_prefix = (
                f"audiobooks/{request.job_id}/checkpoints/"
                f"{request.synthesis_contract}/{plan_hash}/"
            )
            try:
                listed = r2.list_objects_v2(
                    Bucket=request.r2_bucket_name,
                    Prefix=checkpoint_prefix,
                )
                for item in listed.get("Contents", []):
                    if item.get("Key"):
                        r2.delete_object(
                            Bucket=request.r2_bucket_name,
                            Key=item["Key"],
                        )
            except Exception as cleanup_error:
                print(f"[openmoss] checkpoint cleanup skipped: {cleanup_error}")
        return {
            "status": "success",
            "audio_storage_path": output_key,
            "duration_seconds": duration,
            "variant": "openmoss",
            "sentence_count": len(plan),
            "plan_hash": plan_hash,
        }
    except Exception as exc:
        traceback.print_exc()
        send_webhook_sync(
            request.webhook_url,
            {
                "job_id": request.job_id,
                "status": "failed",
                "progress": progress,
                "error_message": str(exc),
            },
        )
        return {"status": "failed", "error": str(exc)}
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@app.function(
    image=runtime_image,
    timeout=1800,
    secrets=[modal.Secret.from_name("echomancer-secrets")],
    volumes={"/models": model_read_volume},
)
@modal.asgi_app()
def fastapi_app():
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.responses import JSONResponse

    web_app = FastAPI(title="Echomancer OpenMOSS Q8")

    def verify_trigger(request: Request) -> None:
        expected = os.environ.get("TTS_TRIGGER_SECRET") or os.environ.get(
            "WEBHOOK_SECRET"
        )
        provided = request.headers.get("x-tts-trigger-secret", "")
        if not expected:
            raise HTTPException(status_code=503, detail="Trigger secret unavailable")
        if not hmac.compare_digest(provided, expected):
            raise HTTPException(status_code=401, detail="Unauthorized")

    @web_app.get("/health")
    async def health() -> JSONResponse:
        return JSONResponse(
            {
                "status": "ok",
                "pipeline": "moss",
                "variant": "openmoss",
                "model": "MOSS-TTS-v1.5-Q8_0",
                "gpu": "L4",
                "strategy": "sentence-reset-style-bank",
                "max_workers": MAX_WORKERS,
                "timestamp": time.time(),
            }
        )

    @web_app.post("/warmup")
    async def warmup(request: Request) -> JSONResponse:
        verify_trigger(request)
        body = await request.json()
        containers = max(1, min(int(body.get("containers", 1)), MAX_WORKERS))
        calls = [
            await OpenMossWorker().info.spawn.aio()
            for _ in range(containers)
        ]
        return JSONResponse(
            {
                "status": "warming",
                "containers_requested": containers,
                "call_ids": [call.object_id for call in calls],
            }
        )

    @web_app.post("/generate_audiobook")
    async def generate_audiobook(request: Request) -> JSONResponse:
        verify_trigger(request)
        body = await request.json()
        try:
            if not re.fullmatch(
                r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-"
                r"[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
                str(body.get("job_id", "")),
            ):
                raise ValueError("Invalid job ID")
            webhook_url = body["webhook_url"]
            app_origin = os.environ.get(
                "NEXT_PUBLIC_APP_URL", "https://echomancer-v2.vercel.app"
            ).rstrip("/")
            if not webhook_url.startswith(f"{app_origin}/api/jobs/"):
                raise ValueError("Invalid webhook URL")
            req = AudiobookRequest(
                job_id=body["job_id"],
                pdf_r2_key=body["pdf_r2_key"],
                voice_r2_key=body["voice_r2_key"],
                start_time=body.get("start_time", 0),
                end_time=body.get("end_time", 30),
                webhook_url=webhook_url,
                book_title=body.get("book_title", "Untitled"),
                voice_name=body.get("voice_name", "Unknown"),
                r2_bucket_name=body.get("r2_bucket_name", "echomancer-audio"),
                pipeline_mode=body.get("pipeline_mode", "moss"),
                tts_variant="openmoss",
                moss_language=body.get("moss_language", "English"),
                reference_segments=body.get("reference_segments"),
                style_selection_seed=body.get("style_selection_seed", 42),
                synthesis_contract=body.get(
                    "synthesis_contract", "openmoss-q8-sentence-v1"
                ),
                narration_instructions=body.get("narration_instructions", ""),
                paragraph_pause_sec=body.get("paragraph_pause_sec", 0.65),
                sentence_pause_sec=body.get("sentence_pause_sec", 0.22),
                audio_temperature=body.get("audio_temperature", 1.7),
                audio_top_p=body.get("audio_top_p", 0.8),
                audio_top_k=body.get("audio_top_k", 25),
                audio_repetition_penalty=body.get(
                    "audio_repetition_penalty", 1.0
                ),
            )
            call = await process_audiobook.spawn.aio(req.__dict__)
            return JSONResponse(
                {
                    "status": "accepted",
                    "job_id": req.job_id,
                    "variant": "openmoss",
                    "model": "MOSS-TTS-v1.5-Q8_0",
                    "call_id": call.object_id,
                }
            )
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))

    @web_app.post("/generate_batch")
    async def generate_batch(request: Request) -> JSONResponse:
        verify_trigger(request)
        body = await request.json()
        texts = body.get("texts") or [body.get("text", "Hello.")]
        results = []
        for index, text in enumerate(texts):
            result = await OpenMossWorker().generate.remote.aio(
                text,
                body["reference_audio_base64"],
                body.get("moss_language", "English"),
                body.get("seed", 42) + index,
            )
            results.append(
                {
                    "audio_base64": result.get("audio_base64"),
                    "duration_seconds": result.get("duration_seconds", 0),
                    "error": result.get("error"),
                    "pipeline_path": "openmoss",
                }
            )
        return JSONResponse(
            {
                "results": results,
                "pipeline_mode": "moss",
                "variant": "openmoss",
                "model": "MOSS-TTS-v1.5-Q8_0",
            }
        )

    return web_app
