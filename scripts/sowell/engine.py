"""Resident Kokoro runtime. One process loads its models once and reuses them.

Kokoro's model is not reentrant, so render holds a lock. A second container
is a second process, not a second thread in this one. Audio is returned as
WAV bytes. There is no shared temporary file.

Two kmodels stay resident:

* stock `kokoro-v1_0.pth`, which speaks Walter (`am_sowell`), George
  (`bm_george`), and Heart (`af_heart`)
* the Drew checkpoint, which speaks Drew only (see `drew.py`)

Drew's kmodel is loaded lazily, on the first Drew request, so a Walter-only
deployment still starts with one model in memory. `@modal.enter` still runs
one warm path for it when the volume is mounted, so the first real Drew
section is not the one that pays for the load.
"""

from __future__ import annotations

import io
import os
import threading
import time
import wave
from pathlib import Path

import torch

from pack import (
    GEORGE_VOICE_FILE,
    GEORGE_VOICE_ID,
    HEART_VOICE_FILE,
    HEART_VOICE_ID,
    PINNED_REPO,
    PINNED_REVISION,
    PINNED_WEIGHTS,
    SOWELL_VOICE_ID,
    PackError,
    canonical_kokoro_voice,
    check_george_voice,
    check_heart_voice,
    check_pack,
    load_manifest,
    manifest_path,
)
from drew import (
    DREW_VOICE_ID,
    DrewPackError,
    check_drew_assets,
    drew_speed,
    load_kmodel,
    load_voice_pack,
)
from style import fixed_style_index, pin_style
from prosody_rules import plan_chunks, prosody_hooks, resolve_prosody
from phoneme_runs import PHONEME_CAP

MAX_CHARS = 2000
SAMPLE_RATE = 24_000

#: Kokoro's pipeline class, imported on first use. Tests replace this name with
#: a stub so the speed plumbing can run without the package installed.
KPipeline = None


def kpipeline():
    """The KPipeline class, imported once. `engine.KPipeline` wins if set."""
    global KPipeline
    if KPipeline is None:
        from kokoro import KPipeline as real

        KPipeline = real
    return KPipeline


def cpu_threads() -> int:
    """Threads for the container's 2 physical cores. Default 4.

    Measured on the deployed image (`modal/sowell_bench.py`, Drew, cpu=2):
    4 threads is about 1.5x faster than 2 (harbor RTF 2.06-2.41 vs 1.46-1.57).
    The clamp is the local CPU count so a smaller host does not over-subscribe.
    """
    raw = os.environ.get("SOWELL_CPU_THREADS", "4")
    try:
        n = int(raw)
    except ValueError:
        n = 4
    return max(1, min(n, os.cpu_count() or 4))


def torch_threads() -> int:
    """Torch intra-op threads for the container.

    ``SOWELL_TORCH_THREADS`` is the knob the Modal worker sets from
    ``@modal.enter``. It falls back to ``SOWELL_CPU_THREADS`` so a deployment
    that only sets the older name keeps working.

    Default 4, measured on the deployed image: 2 threads gave RTF 1.46-1.57 on
    the 719-character harbor paragraph, 4 gave 2.06-2.41 (~1.5x faster).
    """
    raw = os.environ.get("SOWELL_TORCH_THREADS") or os.environ.get(
        "SOWELL_CPU_THREADS", "4"
    )
    try:
        n = int(raw)
    except ValueError:
        n = 4
    return max(1, min(n, os.cpu_count() or 4))


def torch_interop_threads() -> int:
    """Inter-op threads. One is right for a single model on one CPU set."""
    raw = os.environ.get("SOWELL_TORCH_INTEROP_THREADS", "1")
    try:
        n = int(raw)
    except ValueError:
        n = 1
    return max(1, min(n, os.cpu_count() or 1))


def apply_torch_threads() -> int:
    """Apply the thread budget. Returns the intra-op count that was set.

    Called from ``@modal.enter`` before the first model load, so the pool is
    built at the requested size. `set_num_interop_threads` may only be called
    before the inter-op pool starts, so a second call is ignored rather than
    fatal — a warm container must not fail a request over it.
    """
    n = torch_threads()
    torch.set_num_threads(n)
    interop = torch_interop_threads()
    try:
        torch.set_num_interop_threads(interop)
    except RuntimeError:
        pass
    os.environ.setdefault("SOWELL_TORCH_THREADS", str(n))
    return n


def apply_thread_budget() -> int:
    """Legacy name kept for callers that imported it. Now delegates."""
    return apply_torch_threads()


from phoneme_runs import (  # noqa: E402,F401  re-exported for callers and tests
    _graphemes_for,
    _phoneme_pieces,
    _spans_match,
    _token_spans,
    iter_phoneme_runs,
    split_phoneme_run,
    words,
)


class SowellEngine:
    def __init__(self) -> None:
        self.init_count = 0
        self._lock = threading.Lock()
        self._pipelines: dict = {}
        self._packs: dict[str, torch.Tensor] = {}
        # Drew's own model, loaded lazily. A failed load is not sticky: a
        # snapshot taken before the volume is mounted must try again on the
        # next request instead of 503ing until a new snapshot.
        self._drew_pipes: dict | None = None
        self._drew_pack: torch.Tensor | None = None
        self._drew_error: str | None = None

    def load(self, pack_path: Path, manifest_file: Path | None = None) -> None:
        with self._lock:
            if self._pipelines:
                return
            self._load_locked(pack_path, manifest_file)

    def load_drew(self) -> bool:
        """Load Drew's kmodel and pack now. False when the volume is absent.

        The app calls this once from `@modal.enter` so the first Drew request
        is not the one that pays ~2s of disk. A missing volume is not fatal:
        Walter and George must still serve from a deployment that has not had
        the upload yet.
        """
        with self._lock:
            return self._load_drew_locked()

    def _load_drew_locked(self) -> bool:
        if self._drew_pipes is not None:
            return True
        try:
            assets = check_drew_assets()
            model = load_kmodel(assets.kmodel)
            pack = load_voice_pack(assets.voice)
            pipeline_cls = kpipeline()

            # Drew speaks American English, like the Andrew it succeeds.
            self._drew_pipes = {
                "a": pipeline_cls(lang_code="a", repo_id=PINNED_REPO, model=model),
            }
            # One row, copied across the pack at load. Infer still indexes
            # with the phoneme count and still receives drew_speed(speed).
            self._drew_pack = pin_style(pack, fixed_style_index(DREW_VOICE_ID))
            self.init_count += 1
            return True
        except (DrewPackError, PackError) as err:
            self._drew_error = str(err)
            return False

    def speak(
        self,
        text: str,
        pack_path: Path,
        manifest_file: Path | None = None,
        voice: str = SOWELL_VOICE_ID,
        speed: float = 1.0,
        prosody: str | None = None,
    ) -> tuple[bytes, dict]:
        """Load on the first call in this process, then render under the lock.

        ``prosody=""`` is the stock forward even if ``DREW_PROSODY_RULES`` is
        set. The HTTP handler passes that for a request that did not ask for
        variant G, so a container env cannot rule audio cached as unruled.
        ``prosody=None`` is the CLI and reads the env.
        """
        started = time.perf_counter()
        with self._lock:
            inits_before = self.init_count
            load_seconds = 0.0
            load_started = time.perf_counter()
            if voice == DREW_VOICE_ID:
                if not self._load_drew_locked():
                    raise DrewPackError(self._drew_error or "Drew is not loaded")
                voice_id = DREW_VOICE_ID
            else:
                voice_id = canonical_kokoro_voice(voice)
                if not self._pipelines or voice_id not in self._packs:
                    # load() takes the same lock; call the body inline.
                    self._load_locked(pack_path, manifest_file)
            load_seconds = time.perf_counter() - load_started
            audio, spoken, first_audio, chunk_seconds, prosody_name = self._render_locked(
                text, voice_id, speed, prosody
            )
            elapsed = time.perf_counter() - started
        report = {
            "chars": len(" ".join(text.split())),
            "samples": int(audio.numel()),
            "seconds": round(audio.numel() / SAMPLE_RATE, 3),
            "wallSeconds": round(elapsed, 3),
            "loadSeconds": round(load_seconds, 3),
            "firstAudioSeconds": round(first_audio, 3),
            "threads": getattr(self, "_threads", None),
            "initCount": self.init_count,
            "initializedThisCall": self.init_count > inits_before,
            "spokenWords": len(words(spoken)),
            "voice": voice_id,
            "speed": drew_speed(speed) if voice_id == DREW_VOICE_ID else 1.0,
            "styleIndex": fixed_style_index(voice_id),
            "prosody": prosody_name,
            "chunkSeconds": chunk_seconds,
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
        # One model. American phonemes for Walter and Heart, British for George.
        self._pipelines = {
            "a": KPipeline(lang_code="a", repo_id=PINNED_REPO, model=model),
            "b": KPipeline(lang_code="b", repo_id=PINNED_REPO, model=model),
        }
        self._packs = {
            SOWELL_VOICE_ID: pin_style(pack, fixed_style_index(SOWELL_VOICE_ID)),
            GEORGE_VOICE_ID: pin_style(
                self._load_george_voice(), fixed_style_index(GEORGE_VOICE_ID)
            ),
            HEART_VOICE_ID: pin_style(
                self._load_heart_voice(), fixed_style_index(HEART_VOICE_ID)
            ),
        }
        self.init_count += 1

    def _load_george_voice(self) -> torch.Tensor:
        baked = Path(os.environ.get("GEORGE_VOICE", "/opt/sowell/voices/bm_george.pt"))
        if baked.is_file():
            return check_george_voice(baked)
        from huggingface_hub import hf_hub_download

        downloaded = Path(
            hf_hub_download(
                repo_id=PINNED_REPO,
                filename=GEORGE_VOICE_FILE,
                revision=PINNED_REVISION,
            )
        )
        return check_george_voice(downloaded)

    def _load_heart_voice(self) -> torch.Tensor:
        baked = Path(os.environ.get("HEART_VOICE", "/opt/sowell/voices/af_heart.pt"))
        if baked.is_file():
            return check_heart_voice(baked)
        from huggingface_hub import hf_hub_download

        downloaded = Path(
            hf_hub_download(
                repo_id=PINNED_REPO,
                filename=HEART_VOICE_FILE,
                revision=PINNED_REVISION,
            )
        )
        return check_heart_voice(downloaded)

    def _render_locked(
        self,
        text: str,
        voice: str = SOWELL_VOICE_ID,
        speed: float = 1.0,
        prosody: str | None = None,
    ) -> tuple[torch.Tensor, str, float, list[float], str | None]:
        cleaned = " ".join(text.split())
        if not cleaned:
            raise PackError("empty text")
        if len(cleaned) > MAX_CHARS:
            raise PackError(f"{len(cleaned)} characters exceeds the {MAX_CHARS} cap")
        if voice == DREW_VOICE_ID:
            pipeline = (self._drew_pipes or {}).get("a")
            pack = self._drew_pack
            kokoro_speed = drew_speed(speed)
        else:
            voice_id = canonical_kokoro_voice(voice)
            lang = "b" if voice_id == GEORGE_VOICE_ID else "a"
            pipeline = self._pipelines.get(lang)
            pack = self._packs.get(voice_id)
            kokoro_speed = 1.0
        if pipeline is None or pack is None:
            raise PackError("runtime is not loaded")
        try:
            recipe = resolve_prosody(voice, prosody)
        except ValueError as err:
            raise PackError(str(err)) from err
        pipeline_cls = kpipeline()

        _, tokens = pipeline.g2p(cleaned)
        # Materialise the chunks before the forward. Planning a sentence
        # that crosses a 510-phoneme cut is string work, not a model pass.
        # With no recipe this list is what the loop below already walked.
        runs: list[tuple[str, str]] = []
        for graphemes, phonemes in iter_phoneme_runs(pipeline, tokens):
            if not phonemes:
                continue
            if len(phonemes) > PHONEME_CAP:
                raise PackError(
                    f"phoneme run is {len(phonemes)}, over {PHONEME_CAP}; refusing to drop text"
                )
            runs.append((graphemes, phonemes))
        plans = plan_chunks(runs) if recipe is not None else None
        pieces: list[torch.Tensor] = []
        spoken: list[str] = []
        chunk_seconds: list[float] = []
        first_audio = 0.0
        render_started = time.perf_counter()
        with torch.inference_mode():
            for index, (graphemes, phonemes) in enumerate(runs):
                # No recipe: the stock infer, with nothing wrapped. That is
                # the bit-identical path. A recipe edits F0 inside that same
                # call and then puts the predictor methods back.
                if recipe is None:
                    output = pipeline_cls.infer(
                        pipeline.model, phonemes, pack, kokoro_speed
                    )
                else:
                    with prosody_hooks(
                        pipeline.model,
                        phonemes,
                        kokoro_speed,
                        recipe,
                        plans[index] if plans is not None else (),
                    ):
                        output = pipeline_cls.infer(
                            pipeline.model, phonemes, pack, kokoro_speed
                        )
                audio = getattr(output, "audio", None)
                if audio is None:
                    raise PackError("Kokoro returned no audio for a chunk")
                wave = audio.detach().to(dtype=torch.float32, device="cpu").reshape(-1)
                pieces.append(wave)
                spoken.append(graphemes)
                chunk_seconds.append(round(wave.numel() / SAMPLE_RATE, 4))
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
        return audio, joined, first_audio, chunk_seconds, (recipe.name if recipe else None)


def _wav_bytes(audio: torch.Tensor) -> bytes:
    pcm = (audio.clamp(-1, 1) * 32767.0).round().to(torch.int16).numpy()
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(pcm.tobytes())
    return buffer.getvalue()
