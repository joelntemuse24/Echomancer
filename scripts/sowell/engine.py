"""Resident Sowell runtime. One process loads Kokoro once and reuses it.

Kokoro's model is not reentrant, so render holds a lock. A second container
is a second process, not a second thread in this one. Audio is returned as
WAV bytes. There is no shared temporary file.
"""

from __future__ import annotations

import io
import os
import re
import threading
import time
import wave
from pathlib import Path

import torch

from pack import (
    PINNED_REPO,
    PINNED_REVISION,
    PINNED_WEIGHTS,
    PackError,
    check_pack,
    load_manifest,
    manifest_path,
)

MAX_CHARS = 2000
PHONEME_CAP = 510
SAMPLE_RATE = 24_000
_WORDS = re.compile(r"[A-Za-z0-9']+")


def cpu_threads() -> int:
    """Default is the container's 2 CPUs. A higher value is only for a local probe."""
    raw = os.environ.get("SOWELL_CPU_THREADS", "2")
    try:
        n = int(raw)
    except ValueError:
        n = 2
    return max(1, min(n, os.cpu_count() or 2))


def apply_thread_budget() -> int:
    n = cpu_threads()
    torch.set_num_threads(n)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass
    return n


def words(text: str) -> list[str]:
    return _WORDS.findall(text)


class SowellEngine:
    def __init__(self) -> None:
        self.init_count = 0
        self._lock = threading.Lock()
        self._pipeline = None
        self._pack: torch.Tensor | None = None

    def load(self, pack_path: Path, manifest_file: Path | None = None) -> None:
        with self._lock:
            if self._pipeline is not None:
                return
            self._load_locked(pack_path, manifest_file)

    def speak(self, text: str, pack_path: Path, manifest_file: Path | None = None) -> tuple[bytes, dict]:
        """Load on the first call in this process, then render under the lock."""
        started = time.perf_counter()
        with self._lock:
            inits_before = self.init_count
            if self._pipeline is None or self._pack is None:
                # load() takes the same lock; call the body inline.
                self._load_locked(pack_path, manifest_file)
            audio, spoken, first_audio = self._render_locked(text)
            elapsed = time.perf_counter() - started
        report = {
            "chars": len(" ".join(text.split())),
            "samples": int(audio.numel()),
            "seconds": round(audio.numel() / SAMPLE_RATE, 3),
            "wallSeconds": round(elapsed, 3),
            "firstAudioSeconds": round(first_audio, 3),
            "threads": getattr(self, "_threads", None),
            "initCount": self.init_count,
            "initializedThisCall": self.init_count > inits_before,
            "spokenWords": len(words(spoken)),
        }
        return _wav_bytes(audio), report

    def _load_locked(self, pack_path: Path, manifest_file: Path | None) -> None:
        manifest = load_manifest(manifest_file or manifest_path(None))
        pack = check_pack(pack_path, manifest)
        from huggingface_hub import hf_hub_download
        from kokoro import KModel, KPipeline

        config = hf_hub_download(
            repo_id=PINNED_REPO,
            filename="config.json",
            revision=PINNED_REVISION,
        )
        weights = hf_hub_download(
            repo_id=PINNED_REPO,
            filename=PINNED_WEIGHTS,
            revision=PINNED_REVISION,
        )
        model = KModel(repo_id=PINNED_REPO, config=config, model=weights).eval()
        self._threads = apply_thread_budget()
        self._pipeline = KPipeline(lang_code="a", repo_id=PINNED_REPO, model=model)
        self._pack = pack
        self.init_count += 1

    def _render_locked(self, text: str) -> tuple[torch.Tensor, str, float]:
        cleaned = " ".join(text.split())
        if not cleaned:
            raise PackError("empty text")
        if len(cleaned) > MAX_CHARS:
            raise PackError(f"{len(cleaned)} characters exceeds the {MAX_CHARS} cap")
        pipeline = self._pipeline
        pack = self._pack
        if pipeline is None or pack is None:
            raise PackError("runtime is not loaded")
        from kokoro import KPipeline

        _, tokens = pipeline.g2p(cleaned)
        pieces: list[torch.Tensor] = []
        spoken: list[str] = []
        first_audio = 0.0
        render_started = time.perf_counter()
        with torch.inference_mode():
            for graphemes, phonemes, _tokens in pipeline.en_tokenize(tokens):
                if not phonemes:
                    continue
                if len(phonemes) > PHONEME_CAP:
                    raise PackError(
                        f"phoneme run is {len(phonemes)}, over {PHONEME_CAP}; refusing to drop text"
                    )
                output = KPipeline.infer(pipeline.model, phonemes, pack, 1.0)
                audio = getattr(output, "audio", None)
                if audio is None:
                    raise PackError("Kokoro returned no audio for a chunk")
                pieces.append(audio.detach().to(dtype=torch.float32, device="cpu").reshape(-1))
                spoken.append(graphemes)
                if first_audio == 0.0:
                    first_audio = time.perf_counter() - render_started
        if not pieces:
            raise PackError("Kokoro returned no audio")
        joined = " ".join(spoken)
        if words(cleaned) != words(joined):
            raise PackError("spoken text does not match the request")
        audio = torch.cat(pieces)
        if audio.numel() < SAMPLE_RATE // 10 or not bool(torch.isfinite(audio).all()):
            raise PackError("audio is empty or non-finite")
        return audio, joined, first_audio


def _wav_bytes(audio: torch.Tensor) -> bytes:
    pcm = (audio.clamp(-1, 1) * 32767.0).round().to(torch.int16).numpy()
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(pcm.tobytes())
    return buffer.getvalue()
