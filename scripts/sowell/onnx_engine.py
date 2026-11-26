"""Kokoro on ONNX Runtime, with no torch import.

``KOKORO_RUNTIME=onnx`` selects this engine. The image default is torch
(``engine.py``); ONNX is the opt-in.

One process, one ``InferenceSession`` per model, shared by every request.
ONNX Runtime releases the GIL in ``run`` and a session may be run from
several threads at once, so N concurrent requests on N vCPUs each get one
intra-op thread (`KOKORO_ONNX_THREADS`, default 1). Measured on Modal cpu=2
(4 vCPU): 4 x 1 thread gives 1.57x the audio per second of the torch
engine's 1 x 4 threads. G2P (misaki + spaCy) is not proven thread-safe, so it
runs under a lock; it is ~0.2% of a section's time.

Chunks are the torch engine's chunks: the same misaki G2P, the same
``phoneme_runs.iter_phoneme_runs``, the same vocab, the same pinned style
row, the same Drew speed mapping. Prosody G is not applied here.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import threading
import time
import wave
from pathlib import Path

import numpy as np

from phoneme_runs import PHONEME_CAP, Tokenizer, iter_phoneme_runs, words
from pronounce import install_pronunciations, prepare_kokoro_text

MAX_CHARS = 2000
SAMPLE_RATE = 24_000

SOWELL_VOICE_ID = "am_sowell"
GEORGE_VOICE_ID = "bm_george"
HEART_VOICE_ID = "af_heart"
DREW_VOICE_ID = "drew"
STOCK_VOICES = (SOWELL_VOICE_ID, GEORGE_VOICE_ID, HEART_VOICE_ID)

STOCK_DIR = Path(os.environ.get("KOKORO_ONNX_DIR", "/opt/sowell/onnx"))


class OnnxEngineError(RuntimeError):
    pass


def onnx_threads() -> int:
    raw = os.environ.get("KOKORO_ONNX_THREADS", "1")
    try:
        n = int(raw)
    except ValueError:
        n = 1
    return max(1, min(n, os.cpu_count() or 1))


def drew_onnx_dir(env: dict | None = None) -> Path:
    """Drew's export lives on the volume, next to his checkpoint."""
    env = env if env is not None else os.environ
    explicit = env.get("DREW_ONNX_DIR")
    if explicit:
        return Path(explicit)
    mount = env.get("DREW_VOLUME_MOUNT", "/andrew-distill")
    rel = env.get("DREW_ONNX_RELATIVE_DIR", "/kokoro/retrain_v3/stageA/onnx")
    return Path(mount + rel)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def read_manifest(folder: Path, verify: bool = True) -> dict:
    path = folder / "manifest.json"
    if not path.is_file():
        raise OnnxEngineError(f"ONNX export missing: {path}")
    manifest = json.loads(path.read_text())
    if verify:
        for name, digest in manifest.get("files", {}).items():
            file = folder / name
            if not file.is_file():
                raise OnnxEngineError(f"ONNX export file missing: {file}")
            if _sha256(file) != digest:
                raise OnnxEngineError(f"ONNX export hash mismatch: {file}")
    return manifest


def block_torch_import() -> bool:
    """Keep torch out of this process. Returns True when the block is in place.

    spaCy's ``thinc`` imports torch at import time *if it is installed*, and
    the image keeps CPU torch for the fallback runtime and the exporter. That
    one import costs ~1 GB of RSS per process for nothing: misaki's G2P never
    calls it. ``sys.modules["torch"] = None`` turns thinc's ``import torch``
    into the ImportError it already handles. Skipped when torch is already
    loaded (a test, or the torch runtime in the same process).
    """
    import sys

    if os.environ.get("KOKORO_ONNX_ALLOW_TORCH") == "1":
        return False
    if sys.modules.get("torch") is not None:
        return False
    # spaCy loads this plugin on startup and it imports torch unconditionally.
    # The lean image uninstalls it (misaki only needs it for trf=True); if it
    # is present, blocking torch would break spaCy, so leave torch alone.
    import importlib.util

    if importlib.util.find_spec("spacy_curated_transformers") is not None:
        return False
    sys.modules["torch"] = None  # type: ignore[assignment]
    return True


def _session(path: Path):
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.intra_op_num_threads = onnx_threads()
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    # The CPU arena keeps the largest activation set it ever saw (a 510-phoneme
    # run) for the life of the process. With four worker processes that is the
    # difference between sizing the container for four peaks or for one.
    # Measured on the 4-section bench: arena ON was faster (46 s vs 62 s) AND lower peak (1.5 vs 2.0 GB, malloc fragmentation without it), so it stays on; KOKORO_ONNX_ARENA=0 turns it off.
    options.enable_cpu_mem_arena = os.environ.get("KOKORO_ONNX_ARENA", "1") != "0"
    # Measured on Modal with 4 concurrent Drew sections: mem pattern off and
    # the arena growing by the request (not the next power of two) dropped
    # the container peak from 5.9 GB to 5.0 GB. 1 is kSameAsRequested.
    options.enable_mem_pattern = False
    options.add_session_config_entry("session.arena_extend_strategy", "1")
    return ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])


def drew_speed(requested: object) -> float:
    from drew import drew_speed as mapped

    return mapped(requested)


class OnnxEngine:
    def __init__(self) -> None:
        # Locks and ORT sessions are created in ``open_sessions``, after a
        # memory snapshot restores. A lock or an InferenceSession thread pool
        # captured in the snapshot is tied to the process that took it.
        self._g2p_lock: threading.Lock | None = None
        self._load_lock: threading.Lock | None = None
        self._g2p: dict = {}
        self._vocab: dict[str, int] = {}
        self._stock = None
        self._stock_onnx: Path | None = None
        self._drew = None
        self._packs: dict[str, np.ndarray] = {}
        self._drew_error: str | None = None
        self.init_count = 0

    def _ensure_locks(self) -> None:
        if self._load_lock is None:
            self._load_lock = threading.Lock()
            self._g2p_lock = threading.Lock()

    # ---- loading ---------------------------------------------------------
    def load_assets(self, stock_dir: Path | None = None, verify: bool = True) -> None:
        """Packs, vocab, and G2P. No ORT session and no lock.

        This is what ``@modal.enter(snap=True)`` may call. ``open_sessions``
        builds the sessions after restore.
        """
        if self._vocab:
            return
        folder = stock_dir or STOCK_DIR
        manifest = read_manifest(folder, verify=verify)
        self._vocab = json.loads((folder / "vocab.json").read_text())
        for voice in STOCK_VOICES:
            self._packs[voice] = np.load(folder / f"{voice}.npy")
        self._stock_onnx = folder / "kokoro-v1_0.onnx"
        self.torch_blocked = block_torch_import()
        from misaki import en, espeak

        for lang in ("a", "b"):
            british = lang == "b"
            try:
                fallback = espeak.EspeakFallback(british=british)
            except Exception:  # same as KPipeline: OOD words are skipped
                fallback = None
            g2p = en.G2P(trf=False, british=british, fallback=fallback, unk="")
            install_pronunciations(g2p)
            self._g2p[lang] = g2p
        self._manifest = manifest

    def open_sessions(self) -> None:
        """Create the locks and the stock ORT session. Safe after restore."""
        self._ensure_locks()
        assert self._load_lock is not None
        with self._load_lock:
            if self._stock is not None:
                return
            if self._stock_onnx is None:
                raise OnnxEngineError("runtime assets are not loaded")
            self._stock = _session(self._stock_onnx)
            self.init_count += 1

    def load(self, stock_dir: Path | None = None, verify: bool = True) -> None:
        """Assets and sessions, for a process that is not snapshotted."""
        self.load_assets(stock_dir, verify=verify)
        self.open_sessions()

    def load_drew(self, folder: Path | None = None, verify: bool = True) -> bool:
        return self.ensure_drew(folder, verify=verify)

    def ensure_drew(self, folder: Path | None = None, verify: bool = True) -> bool:
        """Load Drew's session. A miss is retried on the next call.

        A snapshot taken before the export exists restores ``_drew is None``.
        The following request tries again under the load lock, so the book
        does not 503 until a new snapshot.
        """
        self._ensure_locks()
        assert self._load_lock is not None
        with self._load_lock:
            if self._drew is not None:
                return True
            try:
                folder = folder or drew_onnx_dir()
                read_manifest(folder, verify=verify)
                self._packs[DREW_VOICE_ID] = np.load(folder / "drew.npy")
                self._drew = _session(folder / "drew.onnx")
                self._drew_error = None
                return True
            except Exception as err:  # missing export → caller decides
                self._drew = None
                self._drew_error = str(err)
                return False

    @property
    def drew_loaded(self) -> bool:
        return self._drew is not None

    @property
    def drew_error(self) -> str | None:
        return self._drew_error

    # ---- speech ----------------------------------------------------------
    def phoneme_runs(self, text: str, lang: str) -> list[tuple[str, str]]:
        self._ensure_locks()
        assert self._g2p_lock is not None
        with self._g2p_lock:
            _, tokens = self._g2p[lang](text)
        runs = []
        for graphemes, phonemes in iter_phoneme_runs(Tokenizer, tokens):
            if not phonemes:
                continue
            if len(phonemes) > PHONEME_CAP:
                raise OnnxEngineError(
                    f"phoneme run is {len(phonemes)}, over {PHONEME_CAP}; refusing to drop text"
                )
            runs.append((graphemes, phonemes))
        return runs

    def speak(self, text: str, voice: str = SOWELL_VOICE_ID, speed: float = 1.0, prosody: str | None = None):
        started = time.perf_counter()
        cleaned = prepare_kokoro_text(text)
        if not cleaned:
            raise OnnxEngineError("empty text")
        if len(cleaned) > MAX_CHARS:
            raise OnnxEngineError(f"{len(cleaned)} characters exceeds the {MAX_CHARS} cap")
        if self._stock is None:
            raise OnnxEngineError("runtime is not loaded")
        if voice == DREW_VOICE_ID:
            if not self.ensure_drew():
                raise OnnxEngineError(self._drew_error or "Drew ONNX export is not loaded")
            session, kokoro_speed, lang = self._drew, drew_speed(speed), "a"
        elif voice in STOCK_VOICES:
            session, kokoro_speed = self._stock, 1.0
            lang = "b" if voice == GEORGE_VOICE_ID else "a"
        else:
            raise OnnxEngineError(f"voice {voice!r} is not allowed")
        pack = self._packs[voice]
        runs = self.phoneme_runs(cleaned, lang)
        pieces: list[np.ndarray] = []
        spoken: list[str] = []
        chunk_seconds: list[float] = []
        first_audio = 0.0
        render_started = time.perf_counter()
        names = [i.name for i in session.get_inputs()]
        for graphemes, phonemes in runs:
            ids = [self._vocab[p] for p in phonemes if p in self._vocab]
            ids = [0, *ids, 0]
            style = np.asarray(pack[len(phonemes) - 1], dtype=np.float32).reshape(1, -1)
            out = session.run(
                None,
                {
                    names[0]: np.asarray([ids], dtype=np.int64),
                    names[1]: style,
                    names[2]: np.asarray([kokoro_speed], dtype=np.float32),
                },
            )[0]
            audio = np.asarray(out, dtype=np.float32).reshape(-1)
            pieces.append(audio)
            spoken.append(graphemes)
            chunk_seconds.append(round(audio.size / SAMPLE_RATE, 4))
            if first_audio == 0.0:
                first_audio = time.perf_counter() - render_started
        if not pieces:
            raise OnnxEngineError("Kokoro returned no audio")
        joined = " ".join(spoken)
        if words(cleaned) != words(joined):
            raise OnnxEngineError("spoken text does not match the request")
        audio = np.concatenate(pieces)
        if audio.size < SAMPLE_RATE // 10 or not bool(np.isfinite(audio).all()):
            raise OnnxEngineError("audio is empty or non-finite")
        elapsed = time.perf_counter() - started
        report = {
            "chars": len(cleaned),
            "samples": int(audio.size),
            "seconds": round(audio.size / SAMPLE_RATE, 3),
            "wallSeconds": round(elapsed, 3),
            "loadSeconds": 0.0,
            "firstAudioSeconds": round(first_audio, 3),
            "threads": onnx_threads(),
            "initCount": self.init_count,
            "initializedThisCall": False,
            "spokenWords": len(words(joined)),
            "voice": voice,
            "speed": kokoro_speed,
            "styleIndex": None,
            # G is a torch hook; this runtime speaks the stock forward.
            "prosody": None,
            "runtime": "onnx",
            "chunkSeconds": chunk_seconds,
        }
        return wav_bytes(audio), report


def wav_bytes(audio: np.ndarray) -> bytes:
    """Same quantisation as ``engine._wav_bytes``: clamp, x32767, round."""
    pcm = np.round(np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(pcm.tobytes())
    return buffer.getvalue()
