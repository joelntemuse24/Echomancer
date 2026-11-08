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
    GEORGE_VOICE_FILE,
    GEORGE_VOICE_ID,
    PINNED_REPO,
    PINNED_REVISION,
    PINNED_WEIGHTS,
    SOWELL_VOICE_ID,
    PackError,
    canonical_kokoro_voice,
    check_george_voice,
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


def iter_phoneme_runs(pipeline, tokens):
    """Yield ``(graphemes, phonemes)`` with each phoneme string at most 510.

    Kokoro 0.9.4 ``en_tokenize`` tries to stay at 510. Its own generator
    then truncates a longer run, which drops speech. This keeps every
    phoneme character: a run of 511 is split on a token boundary, then on
    a space, then at the cap. Joining the pieces returns that run unchanged.
    """
    for graphemes, phonemes, chunk_tokens in pipeline.en_tokenize(tokens):
        if not phonemes:
            continue
        if len(phonemes) <= PHONEME_CAP:
            yield graphemes, phonemes
            continue
        yield from split_phoneme_run(graphemes, phonemes, chunk_tokens)


def split_phoneme_run(graphemes: str, phonemes: str, tokens) -> list[tuple[str, str]]:
    """Split one over-cap run. Pieces join back to ``phonemes`` and stay in order."""
    pieces = _phoneme_pieces(phonemes, tokens)
    if len(pieces) == 1:
        return [(graphemes, pieces[0])]
    spans = _token_spans(tokens, phonemes)
    if not _spans_match(spans, phonemes):
        # The graphemes still have to be spoken once. Park them on the first
        # piece rather than dropping a word when the join cannot be mapped.
        return [(graphemes, pieces[0]), *[("", piece) for piece in pieces[1:]]]
    assigned: list[tuple[str, str]] = []
    cursor = 0
    for index, piece in enumerate(pieces):
        end = cursor + len(piece)
        assigned.append((_graphemes_for(spans, cursor, end), piece))
        cursor = end
    return assigned


def _phoneme_pieces(phonemes: str, tokens) -> list[str]:
    """Cut points that leave every character in order, none added or removed."""
    if len(phonemes) <= PHONEME_CAP:
        return [phonemes]
    spans = _token_spans(tokens, phonemes)
    boundaries = [end for _start, end, _text in spans] if _spans_match(spans, phonemes) else []
    pieces: list[str] = []
    start = 0
    while len(phonemes) - start > PHONEME_CAP:
        window = start + PHONEME_CAP
        cut = 0
        for boundary in boundaries:
            if start < boundary <= window:
                cut = boundary
        if cut <= start:
            space = phonemes.rfind(" ", start + 1, window + 1)
            # Keep the space on the left piece so the pause stays in the run.
            cut = space + 1 if space > start else window
        pieces.append(phonemes[start:cut])
        start = cut
    if start < len(phonemes):
        pieces.append(phonemes[start:])
    return pieces


def _token_spans(tokens, phonemes: str) -> list[tuple[int, int, str]]:
    """Each token's place in the phoneme string Kokoro actually yielded."""
    raw_parts: list[str] = []
    raw_ends: list[int] = []
    texts: list[str] = []
    for token in tokens:
        spoken = "" if token.phonemes is None else token.phonemes
        raw_parts.append(spoken + (" " if token.whitespace else ""))
        raw_ends.append(sum(len(part) for part in raw_parts))
        texts.append(f"{token.text}{token.whitespace}")
    raw = "".join(raw_parts)
    leading = len(raw) - len(raw.lstrip())
    spans: list[tuple[int, int, str]] = []
    previous = 0
    for raw_end, text in zip(raw_ends, texts):
        start = max(0, min(len(phonemes), previous - leading))
        end = max(start, min(len(phonemes), raw_end - leading))
        spans.append((start, end, text))
        previous = raw_end
    return spans


def _spans_match(spans: list[tuple[int, int, str]], phonemes: str) -> bool:
    if not phonemes:
        return True
    if not spans:
        return False
    return spans[-1][1] == len(phonemes)


def _graphemes_for(spans: list[tuple[int, int, str]], start: int, end: int) -> str:
    """Token text that begins in this piece. A hard cut does not repeat it."""
    parts: list[str] = []
    for token_start, token_end, text in spans:
        if token_start == token_end:
            # No phonemes of its own. Keep it once, on the piece that ends here,
            # or on the first piece when it sits at the start.
            on_left_edge = token_end == end and end != start
            at_start = start == 0 and token_start == 0
            if on_left_edge or at_start:
                parts.append(text)
            continue
        if start <= token_start < end:
            parts.append(text)
    return "".join(parts).strip()


class SowellEngine:
    def __init__(self) -> None:
        self.init_count = 0
        self._lock = threading.Lock()
        self._pipelines: dict = {}
        self._packs: dict[str, torch.Tensor] = {}

    def load(self, pack_path: Path, manifest_file: Path | None = None) -> None:
        with self._lock:
            if self._pipelines:
                return
            self._load_locked(pack_path, manifest_file)

    def speak(
        self,
        text: str,
        pack_path: Path,
        manifest_file: Path | None = None,
        voice: str = SOWELL_VOICE_ID,
    ) -> tuple[bytes, dict]:
        """Load on the first call in this process, then render under the lock."""
        voice_id = canonical_kokoro_voice(voice)
        started = time.perf_counter()
        with self._lock:
            inits_before = self.init_count
            load_seconds = 0.0
            if not self._pipelines or voice_id not in self._packs:
                # load() takes the same lock; call the body inline.
                load_started = time.perf_counter()
                self._load_locked(pack_path, manifest_file)
                load_seconds = time.perf_counter() - load_started
            audio, spoken, first_audio = self._render_locked(text, voice_id)
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
        # One model. American phonemes for the Sowell pack, British for George.
        self._pipelines = {
            "a": KPipeline(lang_code="a", repo_id=PINNED_REPO, model=model),
            "b": KPipeline(lang_code="b", repo_id=PINNED_REPO, model=model),
        }
        self._packs = {
            SOWELL_VOICE_ID: pack,
            GEORGE_VOICE_ID: self._load_george_voice(),
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

    def _render_locked(self, text: str, voice: str = SOWELL_VOICE_ID) -> tuple[torch.Tensor, str, float]:
        cleaned = " ".join(text.split())
        if not cleaned:
            raise PackError("empty text")
        if len(cleaned) > MAX_CHARS:
            raise PackError(f"{len(cleaned)} characters exceeds the {MAX_CHARS} cap")
        voice_id = canonical_kokoro_voice(voice)
        lang = "b" if voice_id == GEORGE_VOICE_ID else "a"
        pipeline = self._pipelines.get(lang)
        pack = self._packs.get(voice_id)
        if pipeline is None or pack is None:
            raise PackError("runtime is not loaded")
        from kokoro import KPipeline

        _, tokens = pipeline.g2p(cleaned)
        pieces: list[torch.Tensor] = []
        spoken: list[str] = []
        first_audio = 0.0
        render_started = time.perf_counter()
        with torch.inference_mode():
            for graphemes, phonemes in iter_phoneme_runs(pipeline, tokens):
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
