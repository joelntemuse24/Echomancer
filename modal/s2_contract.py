"""Pure helpers shared by the S2-Pro clone service and its staging script.

Nothing here imports `torch` or `fastapi`, so it can be imported by unit tests
on a laptop and by the GPU image alike. That keeps the request-validation rules
(which is where an empty reference clip used to kill a snapshot warm-up), the
GPU-affinity rules and the boot metrics testable without a GPU.

Units are bytes, seconds and whole characters throughout.
"""

from __future__ import annotations

import array
import hashlib
import math
import queue
import re
import struct
import sys
import threading
import time
from typing import Any, Callable

# ── reference clip validation ───────────────────────────────────────────────

#: The app caps a clone sample at 15 MiB; the container refuses the same.
REFERENCE_MAX_BYTES = 15 * 1024 * 1024

#: Shorter than this cannot carry a usable speaker prompt. 300 ms is well
#: under the 10 s floor the UI enforces, so it only ever rejects a truncated
#: or empty file rather than a legitimately short clip.
REFERENCE_MIN_BYTES = 4_000
REFERENCE_MIN_SECONDS = 0.30

#: Full-scale RMS is 1.0. A digital-silence clip measures 0.0; a clip that is
#: only a codec header measures 0.0 too. 1e-4 is -80 dBFS.
REFERENCE_MIN_RMS = 1e-4

#: A take whose samples are all one constant value is a flat line, not speech.
REFERENCE_MIN_DISTINCT_SAMPLES = 8


class ReferenceClipError(ValueError):
    """The reference clip cannot be used as a clone prompt."""


class ReferenceTextError(ValueError):
    """The reference transcript is empty or placeholder-only."""


def _wav_pcm(audio: bytes) -> tuple[array.array, int, int] | None:
    """Decode a 16-bit PCM RIFF/WAVE payload. Returns (samples, rate, channels).

    Only the shapes our own pipeline writes are read: 8/16/24/32-bit PCM or
    32-bit float. Anything else (MP3, WebM, a container with a compressed
    codec) returns None and the byte-level checks decide instead.
    """
    if len(audio) < 44 or audio[0:4] != b"RIFF" or audio[8:12] != b"WAVE":
        return None
    offset = 12
    fmt: tuple[int, int, int, int] | None = None  # (format, channels, rate, bits)
    data: memoryview | None = None
    while offset + 8 <= len(audio):
        chunk_id = bytes(audio[offset : offset + 4])
        (size,) = struct.unpack_from("<I", audio, offset + 4)
        start = offset + 8
        end = min(len(audio), start + size)
        if chunk_id == b"fmt " and start + 16 <= len(audio):
            # WAVEFORMATEX: tag, channels, sample rate, byte rate, block align,
            # bits per sample. The bits field is at offset 14, not 8.
            format_tag, channels, rate, _byte_rate, _align, bits = struct.unpack_from(
                "<HHIIHH", audio, start
            )
            fmt = (format_tag, channels, rate, bits)
        elif chunk_id == b"data":
            data = memoryview(audio)[start:end]
            break
        offset = start + size + (size % 2)
    if fmt is None or data is None or not data:
        return None
    format_tag, channels, rate, bits = fmt
    if channels < 1 or rate < 1:
        return None
    width = bits // 8
    if width < 1 or len(data) < width * channels:
        return None
    usable = len(data) - (len(data) % (width * channels))
    samples = array.array("f")
    if format_tag == 3 and bits == 32:
        floats = array.array("f")
        floats.frombytes(bytes(data[:usable]))
        if sys.byteorder != "little":
            floats.byteswap()
        samples = floats
    elif format_tag == 1 and bits == 16:
        ints = array.array("h")
        ints.frombytes(bytes(data[:usable]))
        if sys.byteorder != "little":
            ints.byteswap()
        samples = array.array("f", (v / 32768.0 for v in ints))
    elif format_tag == 1 and bits == 8:
        raw = bytes(data[:usable])
        samples = array.array("f", ((b - 128) / 128.0 for b in raw))
    elif format_tag == 1 and bits == 32:
        ints = array.array("i")
        ints.frombytes(bytes(data[:usable]))
        if sys.byteorder != "little":
            ints.byteswap()
        samples = array.array("f", (v / 2147483648.0 for v in ints))
    else:
        return None
    return samples, rate, channels


def reference_stats(audio: bytes) -> dict:
    """Cheap measurements used by the validation rules and by health output."""
    decoded = _wav_pcm(audio)
    if decoded is None:
        nonzero = sum(1 for b in audio[:65536] if b) if audio else 0
        return {
            "format": "opaque",
            "bytes": len(audio),
            "seconds": None,
            "rms": None,
            "peak": None,
            "distinct": nonzero,
        }
    samples, rate, channels = decoded
    total = len(samples) // channels
    if total == 0:
        return {
            "format": "wav",
            "bytes": len(audio),
            "seconds": 0.0,
            "rms": 0.0,
            "peak": 0.0,
            "distinct": 0,
        }
    energy = 0.0
    peak = 0.0
    distinct: set[int] = set()
    step = max(1, total // 200_000)  # at most ~200k reads on a long clip
    counted = 0
    for i in range(0, total, step):
        v = samples[i * channels]
        energy += v * v
        if abs(v) > peak:
            peak = abs(v)
        if len(distinct) < 64:
            distinct.add(int(v * 100_000))
        counted += 1
    rms = math.sqrt(energy / counted) if counted else 0.0
    return {
        "format": "wav",
        "bytes": len(audio),
        "seconds": round(total / rate, 3),
        "rms": round(rms, 6),
        "peak": round(peak, 6),
        "distinct": len(distinct),
    }


def _pcm16_stats(pcm: bytes, rate: int) -> dict:
    """Same measurements as {@link reference_stats}, over s16le mono PCM."""
    import array

    samples = array.array("h")
    samples.frombytes(pcm[: len(pcm) - (len(pcm) % 2)])
    if sys.byteorder != "little":
        samples.byteswap()
    total = len(samples)
    if total == 0:
        return {"seconds": 0.0, "rms": 0.0, "peak": 0.0, "distinct": 0}
    energy = 0.0
    peak = 0.0
    distinct: set[int] = set()
    step = max(1, total // 200_000)  # at most ~200k reads on a long clip
    counted = 0
    for i in range(0, total, step):
        v = samples[i] / 32768.0
        energy += v * v
        if abs(v) > peak:
            peak = abs(v)
        if len(distinct) < 64:
            distinct.add(int(v * 100_000))
        counted += 1
    rms = math.sqrt(energy / counted) if counted else 0.0
    return {
        "seconds": round(total / rate, 3),
        "rms": round(rms, 6),
        "peak": round(peak, 6),
        "distinct": len(distinct),
    }


# ── reference decode ───────────────────────────────────────────────────────

#: 16-bit mono little-endian PCM, the one shape this decoder emits. The codec
#: wants float samples, so the caller scales this rather than asking ffmpeg for
#: a third representation.
REFERENCE_DECODE_RATE = 44_100
REFERENCE_DECODE_FORMAT = "s16le"

#: Container names `reference_container` can return. Used for the temporary
#: file's suffix and for the error text; ffmpeg detects the format from bytes.
REFERENCE_CONTAINERS = ("wav", "mp3", "m4a", "webm", "ogg", "flac", "mp4")


def reference_container(audio: bytes | None) -> str:
    """Best-effort container name from magic bytes. `"unknown"` if unrecognised.

    Reported on every batch response and in the log: the production 500 on
    `job 5f09ee0e` was a non-WAV reference, and a WAV-only reader made that
    look like a codec fault rather than an unsupported input.
    """
    if not audio:
        return "unknown"
    head = bytes(audio[:12])
    if head[0:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "wav"
    if head[0:4] == b"fLaC":
        return "flac"
    if head[0:4] == b"OggS":
        return "ogg"
    if head[0:3] == b"ID3":
        return "mp3"
    if len(head) >= 2 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0:
        return "mp3"
    if head[0:4] == b"\x1aE\xdf\xa3":
        return "webm"
    if head[4:8] == b"ftyp":
        # ISO-BMFF carries audio and video. The brand decides which spelling a
        # person would expect; it changes nothing about how ffmpeg reads it.
        return "m4a" if head[8:12] in (b"M4A ", b"dash") else "mp4"
    return "unknown"


def decode_reference_pcm(
    audio: bytes | None,
    *,
    rate: int = REFERENCE_DECODE_RATE,
    ffmpeg: str = "ffmpeg",
    timeout_s: float = 120.0,
) -> tuple[bytes, int, int]:
    """Decode any container ffmpeg reads into raw s16le mono PCM.

    Returns `(pcm, sample_rate, channels)`; `channels` is always 1 because the
    downmix happens inside ffmpeg.

    This exists because `torchaudio.load` on this image is PyAV-backed, and the
    PyAV under fish-speech's lockfile predates the `metadata_errors` kwarg that
    current `faster-whisper` passes to `av.open`. Every non-WAV reference
    therefore raised `TypeError: open() got an unexpected keyword argument
    'metadata_errors'` and answered HTTP 500 — a provider fault with no
    workaround on the caller side. ffmpeg is already a hard dependency of this
    image (it writes every section MP3), so decoding through it removes the
    coupling instead of pinning a wheel against a library that will move again.

    WAV is read with the standard library by {@link decode_reference_samples}
    and never reaches this function.
    """
    import subprocess
    import tempfile

    if not audio:
        raise ReferenceClipError("reference clip is empty (0 bytes)")

    # Some demuxers need a seekable input, so use a real file rather than a
    # pipe. The suffix is cosmetic; the bytes decide the format.
    container = reference_container(audio)
    suffix = f".{container}" if container in REFERENCE_CONTAINERS else ".bin"
    with tempfile.NamedTemporaryFile(suffix=suffix) as handle:
        handle.write(audio)
        handle.flush()
        try:
            proc = subprocess.run(
                [
                    ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error",
                    "-i", handle.name,
                    # A video container's cover art is not an audio stream.
                    "-vn",
                    "-f", REFERENCE_DECODE_FORMAT, "-ac", "1", "-ar", str(rate),
                    "pipe:1",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout_s,
            )
        except FileNotFoundError as err:
            raise ReferenceClipError(
                f"ffmpeg is not available to decode a {container} reference"
            ) from err
        except subprocess.TimeoutExpired as err:
            raise ReferenceClipError(
                f"decoding this {container} reference took longer than {timeout_s:.0f}s"
            ) from err

    pcm = proc.stdout or b""
    if proc.returncode != 0 or not pcm:
        detail = (proc.stderr or b"").decode("utf-8", "replace")
        # Short: this text travels back to the client and into the job log.
        detail = " ".join(detail.split())[:300] or "no audio stream decoded"
        raise ReferenceClipError(
            f"could not decode a {container} reference ({len(audio)} bytes): {detail}"
        )
    # One sample is 2 bytes at s16le mono, so a trailing odd byte is not one.
    usable = len(pcm) - (len(pcm) % 2)
    if usable < 2:
        raise ReferenceClipError(f"the {container} reference decoded to no samples")
    return pcm[:usable], rate, 1


def decode_reference_samples(
    audio: bytes | None, *, ffmpeg: str = "ffmpeg"
) -> tuple[bytes, int, int]:
    """Decode a reference clip to **mono** s16le PCM, without a shell-out for WAV.

    Returns `(pcm, sample_rate, 1)`. Stereo is downmixed here rather than by the
    caller, because every consumer (the codec, Whisper) wants one channel and
    forgetting that silently plays the interleaved samples at double speed.

    `_wav_pcm` reads 8/16/32-bit PCM and 32-bit float WAV with the standard
    library, which is what our own pipeline writes. Anything it cannot read — a
    compressed WAV, or any MP3/M4A/WebM/OGG/FLAC clip a person uploaded — goes
    through {@link decode_reference_pcm}.
    """
    import array

    if not audio:
        raise ReferenceClipError("reference clip is empty (0 bytes)")
    decoded = _wav_pcm(audio)
    if decoded is None:
        return decode_reference_pcm(audio, ffmpeg=ffmpeg)
    samples, rate, channels = decoded
    if channels < 1 or rate < 1:
        raise ReferenceClipError(f"reference WAV has {channels} channels at {rate} Hz")
    frames = len(samples) // channels
    out = array.array("h", bytes(frames * 2))
    for i in range(frames):
        base = i * channels
        value = sum(samples[base : base + channels]) / channels
        out[i] = int(round(max(-1.0, min(1.0, value)) * 32767))
    if len(out) < 2:
        raise ReferenceClipError("reference WAV decoded to no samples")
    if sys.byteorder != "little":
        out.byteswap()
    return out.tobytes(), rate, 1


def reference_float_samples(
    audio: bytes | None,
    *,
    target_rate: int | None = None,
    ffmpeg: str = "ffmpeg",
) -> "list[float] | object":
    """Decoded reference as normalized float samples, optionally resampled.

    Returns a plain list of floats at `target_rate` (or the clip's own rate when
    `target_rate` is None). Kept stdlib-only so it can be unit-tested without
    torch: the container wraps the result with `torch.from_numpy`, which is the
    one line that needs the GPU image.

    Linear interpolation is enough here. A reference prompt is 10–40 s of
    speech for a codec that re-derives its own frames, and the alternative on
    this image was `torchaudio.functional.resample` — i.e. the decoder path that
    raised `TypeError` on every non-WAV clip.
    """
    pcm, rate, _channels = decode_reference_samples(audio, ffmpeg=ffmpeg)
    samples = _pcm16_list(pcm)
    if target_rate is None or target_rate == rate or not samples:
        return samples
    ratio = target_rate / rate
    target = max(1, int(round(len(samples) * ratio)))
    if target == 1:
        return [samples[0]]
    step = (len(samples) - 1) / (target - 1)
    out: list[float] = []
    last = len(samples) - 1
    for i in range(target):
        pos = i * step
        lo = int(pos)
        hi = min(lo + 1, last)
        frac = pos - lo
        out.append(samples[lo] * (1.0 - frac) + samples[hi] * frac)
    return out


def _pcm16_list(pcm: bytes) -> list[float]:
    """s16le bytes → floats in [-1, 1). One sample is two little-endian bytes."""
    import array

    samples = array.array("h")
    samples.frombytes(pcm[: len(pcm) - (len(pcm) % 2)])
    if sys.byteorder != "little":
        samples.byteswap()
    return [v / 32768.0 for v in samples]


def decoded_reference_stats(audio: bytes | None) -> dict:
    """Measurements for any reference container, decoding when it is not WAV.

    `reference_stats` reads WAV with the standard library and reports
    `"opaque"` for everything else, which let a silent or truncated MP3 skip
    every amplitude rule. Here a non-WAV clip is decoded through ffmpeg first,
    so the same silence, flat-line and length rules apply to the formats the
    worker actually sends.
    """
    if not audio:
        raise ReferenceClipError("reference clip is empty (0 bytes)")
    container = reference_container(audio)
    if container == "wav" and _wav_pcm(audio) is not None:
        stats = {**reference_stats(audio), "container": "wav"}
        return stats
    pcm, rate, _channels = decode_reference_samples(audio)
    return {
        "format": "decoded",
        "container": container,
        "bytes": len(audio),
        **_pcm16_stats(pcm, rate),
    }


def validate_reference_audio(audio: bytes | None) -> dict:
    """Raise {@link ReferenceClipError} unless this clip can prompt a clone.

    The previous warm-up passed an empty file, so `torchaudio.load` raised and
    the snapshot build failed with a stack trace that did not name the cause.
    Every rule here reports what is wrong with the clip.

    Non-WAV clips are **decoded here**, before any GPU work, so an unsupported
    or corrupt container is a named 422 instead of the container answering 500
    from deep inside the codec. That is exactly what `job 5f09ee0e` hit: an
    MP3/M4A reference reached `av.open` with the pre-19 metadata kwarg, and the
    PyAV under fish-speech's lockfile does not accept it.
    """
    if not audio:
        raise ReferenceClipError("reference clip is empty (0 bytes)")
    if len(audio) < REFERENCE_MIN_BYTES:
        raise ReferenceClipError(
            f"reference clip is {len(audio)} bytes; need at least {REFERENCE_MIN_BYTES}"
        )
    if len(audio) > REFERENCE_MAX_BYTES:
        raise ReferenceClipError(
            f"reference clip is {len(audio)} bytes; the cap is {REFERENCE_MAX_BYTES}"
        )
    if not any(audio[:4096]):
        raise ReferenceClipError("reference clip begins with 4096 zero bytes")
    stats = decoded_reference_stats(audio)
    if stats["seconds"] is not None and stats["seconds"] < REFERENCE_MIN_SECONDS:
        raise ReferenceClipError(
            f"reference clip is {stats['seconds']}s; need at least {REFERENCE_MIN_SECONDS}s"
        )
    rms = stats["rms"]
    if rms is not None and rms < REFERENCE_MIN_RMS:
        raise ReferenceClipError(
            f"reference clip is silent (rms {rms}); need at least {REFERENCE_MIN_RMS}"
        )
    if stats["distinct"] < REFERENCE_MIN_DISTINCT_SAMPLES:
        raise ReferenceClipError(
            "reference clip has a flat-line waveform; it cannot prompt a voice"
        )
    return stats


#: Placeholder transcripts the picker can send when a clip has no words.
_PLACEHOLDER_TEXTS = {
    "",
    ".",
    "...",
    "-",
    "n/a",
    "na",
    "none",
    "null",
    "unknown",
    "no transcript",
    "transcript",
}


def validate_reference_text(text: str | None) -> str:
    """Return the trimmed transcript or raise {@link ReferenceTextError}.

    Fish's prompt format drops a reference that has no text, so an empty
    transcript silently turns a clone into an unguided voice. That used to
    surface only as "the clone does not sound like me".
    """
    cleaned = (text or "").strip()
    if cleaned.lower() in _PLACEHOLDER_TEXTS:
        raise ReferenceTextError(
            "reference transcript is empty; Fish drops a reference without text"
        )
    if not any(ch.isalnum() for ch in cleaned):
        raise ReferenceTextError("reference transcript has no letters or digits")
    return cleaned


# ── sampling ────────────────────────────────────────────────────────────────


class SamplingError(ValueError):
    pass


def parse_sampling(raw: str | None, default: str = "0.9,0.9") -> tuple[float, float]:
    """`"temperature,top_p"` → two clamped floats.

    The value travels to the model as tensors, so a malformed string must fail
    loudly here rather than reach the compiled decode step.
    """
    text = (raw or "").strip() or default
    parts = [p.strip() for p in text.split(",")]
    if len(parts) != 2:
        raise SamplingError(f"sampling must be 'temperature,top_p', got {text!r}")
    try:
        temperature, top_p = (float(p) for p in parts)
    except ValueError as err:
        raise SamplingError(f"sampling is not numeric: {text!r}") from err
    for name, value in (("temperature", temperature), ("top_p", top_p)):
        if not (0.0 < value <= 2.0):
            raise SamplingError(f"{name} {value} is outside (0, 2]")
    return temperature, top_p


# ── lane planning ───────────────────────────────────────────────────────────


def plan_lane_sections(
    pending: list[str],
    *,
    lanes: int,
    batch: int,
    max_tick_chars: int,
) -> list[list[str]]:
    """Split a tick's pending sections into up to `lanes` GPU-sized batches.

    One lane is one HTTP call and one container, so a lane never exceeds
    `batch` (the model's decode batch) and never exceeds `max_tick_chars` on
    its own — that second cap is what stops one very long book section from
    filling a container that four sections could have shared.

    Sections keep their original order inside a lane, and lanes are filled
    round-robin so a slow section does not sit behind every other section in
    the same lane.
    """
    if lanes < 1:
        raise ValueError("lanes must be at least 1")
    if batch < 1:
        raise ValueError("batch must be at least 1")
    groups: list[list[str]] = [[] for _ in range(lanes)]
    chars = [0] * lanes
    for text in pending:
        # Fill the emptiest lane that can still take this section, so lanes
        # stay level instead of the first one absorbing everything.
        order = sorted(range(lanes), key=lambda lane: chars[lane])
        placed = False
        for lane in order:
            if len(groups[lane]) >= batch:
                continue
            if groups[lane] and chars[lane] + len(text) > max_tick_chars:
                continue
            groups[lane].append(text)
            chars[lane] += len(text)
            placed = True
            break
        if not placed:
            break  # every lane is full; the rest waits for a later tick
    return [g for g in groups if g]


#: There is exactly **one** width authority for a clone unit: `UNIT_MAX_CHARS`.
#:
#: #244 and #245 each had two (`UNIT_TARGET_CHARS` to pack toward, `UNIT_MAX_CHARS`
#: as a ceiling), and the pair is why the "small chunks" complaint survived two
#: rounds of tuning: the target decided the boundary count, the ceiling only
#: decided what was legal, and lowering one while the other still forced
#: sentence-sized pieces changed almost nothing audible.
#:
#: A unit boundary is a hard splice between two independently generated takes —
#: each take's own trailing silence is trimmed and a fixed pause is inserted —
#: so the only number that matters is **how many splices a paragraph receives**.
#: That is now decided by `UNIT_MAX_CHARS` alone: if the paragraph fits, it is one
#: take; if not, it is cut into the fewest balanced takes the ceiling allows.
#:
#: Measured on job-sized real prose (two ~17,100-character books packed into
#: ~2,000-character clone sections, the shape of `job 1f0137a1`):
#:
#: | recipe | units | splices | mean unit | forced clause breaks |
#: |--|--|--|--|--|
#: | #244: 200 / 300 | 78 / 74 | 68 / 67 | 219 / 231 | 30 / 13 |
#: | #245: 300 / 400 | 57 / 55 | 47 / 48 | 299 / 311 | 13 / 6 |
#: | now: ceiling 560 | 43 / 40 | 33 / 33 | 397 / 427 | 8 / 3 |
#:
#: (Pride and Prejudice / the Federalist Papers.) So a listener hears **about a
#: third fewer** splices than on #245 and **half** as many as on #244, and a
#: paragraph shorter than the ceiling receives none at all — the share of
#: paragraphs sent as one unbroken take rises from 0 % at #245's ceiling to
#: 71 % / 35 % on the same text. Forced mid-sentence cuts are two to four times
#: rarer, which is the other half of "stops and starts": a clause break is where
#: the model stops in the middle of a thought.

#: Longest single unit — a hard ceiling set by the model, not by taste.
#:
#: The binding constraint is the decode loop's per-unit frame cap:
#: `MAX_NEW_FRAMES` in `s2_batch.py` is 1024 frames, and the codec emits
#: `44100 / frame_length` ≈ 21.5 frames per second, so one generation can speak
#: **~47.6 s** before it is cut off. A cut-off take is a *truncated* unit: the
#: worker treats `truncated_units > 0` as an incomplete section, retries it, and
#: the section fails if it truncates again. So the ceiling has to be a length
#: that cannot plausibly exceed 47.6 s.
#:
#: Modal renders at the model's own pace — unlike the direct Fish adapter it is
#: never sent a `prosody.speed` — and the measured figure is **16.3–17.3 chars
#: per audio second** (`12534aaa`: 16,990 chars in 1,040 s; `1f0137a1`: 17,023
#: in 985 s). At a deliberately pessimistic **13 chars/s** (780 chars/min,
#: slower than any narration this pipeline produces), 560 chars is 43.1 s
#: ≈ 928 frames — inside 1024 with ~96 frames (4.5 s) to spare. At the measured
#: pace it is ~33 s ≈ 700 frames, i.e. ~68 % of the cap. 600 chars would leave
#: only ~1 s of headroom at 13 chars/s, which is not worth 0.1 fewer splices per
#: minute: a take that hits the cap is truncated, the section is retried, and
#: the book visibly fails if it truncates twice.
#:
#: `UNIT_MAX_CHARS` and `MAX_NEW_FRAMES` are therefore a pair, and
#: `modal/test_s2_contract.py` reads the constant out of `s2_batch.py` and fails
#: if this ceiling no longer fits the frame budget at 13 chars/s. Raising the cap
#: is a separate change: it needs a measured GPU run (quality and VRAM at longer
#: single generations) and a snapshot rebuild, so it is not bundled here.
#:
#: It is also a ceiling and not a goal: `split_long_text` only reaches it when
#: one sentence is genuinely that long. The 318-char em-dash sentence that broke
#: `job 1f0137a1` section 2 is a legal unit either way and never reaches the
#: clause path.
UNIT_MAX_CHARS = 560

#: Combined width under which two adjacent short *paragraph* units are merged
#: into one generation.
#:
#: A paragraph break is a real beat (0.96 s), so merging two ordinary paragraphs
#: would run them together with no pause at all — the model reads a bare newline
#: with no instruction to breathe. The merge exists for the opposite case, a run
#: of one-line dialogue or a list of scraps, where a full paragraph pause after
#: every 30-character line is what sounds mechanical. 260 chars is about two
#: short spoken lines, and anything longer keeps its own paragraph beat.
MERGE_PARA_MAX_CHARS = 260

# ── unit splitting: never lose text, never emit an oversized unit ──────────
#
# This lives here, not in `s2_batch.py`, because it is pure text manipulation
# and `s2_batch.py` imports `modal` (unavailable in a laptop test run: the repo
# directory `modal/` shadows the package). Keeping it stdlib-only is what lets
# the exact sentence that broke `job 1f0137a1` be a regression test.
#
# The 2026-11-06 failure:
#
#     section 2 ... 422 section_invalid: "unit of 318 chars was not split"
#
# The sentence ended `...far more dynamic—something never before seen...` — an
# em dash with **no space after it**. `_CLAUSE_END` was `(?<=[,:\u2014])\s+`,
# which requires whitespace *after* the dash, so it never matched; the sentence
# splitter did not match either; the 318-char paragraph went out as one unit,
# the container rejected it, and the whole 1,705-char section was dropped from
# the book. One unsplittable clause costs a section, so the splitter must be
# total: it must always be able to reach a legal unit.

#: Sentence end: terminal punctuation followed by whitespace, keeping the usual
#: abbreviations from ending a sentence. Unchanged from the pre-fix behaviour.
_SENTENCE_END = re.compile(
    r"(?<=[.!?;])(?<!Mr\.)(?<!Mrs\.)(?<!Ms\.)(?<!Dr\.)(?<!St\.)\s+"
)

#: Clause boundaries: a comma, colon, or dash **as a split point itself**, with
#: or without whitespace after it. The old pattern required `\s+`; that is what
#: made `dynamic—something` unsplittable. Zero-width lookbehind, so the
#: punctuation stays with the left-hand piece and no character is consumed.
#:
#: Includes the Unicode dash family (em, en, horizontal bar, figure dash) because
#: prose uses them interchangeably and a book will not telegraph which.
_CLAUSE_END = re.compile(r"(?<=[,:;\u2014\u2013\u2015\u2012])")

#: Last-resort split points when neither punctuation rule can bound a piece:
#: any whitespace. A 300-char token with no spaces at all (a URL, a glued OCR
#: run) still has to be broken, so there is a final hard slice.
_SOFT_BREAK = re.compile(r"\s+")


def _hard_slice(text: str, limit: int) -> list[str]:
    """Break `text` into <= `limit` chunks without dropping a character.

    Prefers a whitespace boundary inside the window so a word is not cut;
    falls back to a raw slice when there is none (a single huge token). This is
    the guarantee that the splitter is total — whatever the input, the result
    is a list of legal units whose concatenation is the original text.
    """
    if limit < 1:
        raise ValueError("limit must be at least 1")
    out: list[str] = []
    rest = text
    while len(rest) > limit:
        window = rest[:limit]
        cut = -1
        for match in _SOFT_BREAK.finditer(window):
            cut = match.start()
        if cut <= 0:
            cut = limit
        out.append(rest[:cut].rstrip())
        rest = rest[cut:].lstrip()
    if rest:
        out.append(rest)
    return [chunk for chunk in out if chunk]


#: A unit shorter than this fraction of the longest one in the same paragraph is
#: a stub. It is the threshold the balance tests assert against, and it is why
#: `_balanced_pack` minimises *and* evens out: minimising the longest unit alone
#: is also achieved by "eight full takes and one sentence".
TAIL_FOLD_RATIO = 0.5


def _balanced_pack(sentences: list[str], *, hard_max: int) -> list[str]:
    """Cut a list of sentence pieces into the **fewest, most even** legal units.

    Greedy packing at a fixed target is what produced stubs. A 4,388-char
    paragraph of 132-char sentences at target 480 packs `531 × 8 + 132`, and
    that last unit is a nine-second take with a full paragraph pause after it.
    Every stub is another splice, which is exactly the "stops and starts" a
    listener reports.

    Two steps:

    1. **How many units?** Greedy at a `hard_max` ceiling is optimal for
       minimising the count of contiguous groups, so that count is the floor.
    2. **How are they distributed?** With that count fixed, a dynamic program
       minimises the longest unit, so 33 sentences in 9 units come out
       `4, 4, 4, 3, 4, 4, 3, 4, 3` rather than `4 × 8 + 1`.

    Every piece is already at or under `hard_max` (the caller's `bounded`
    contract), so a solution always exists.
    """
    texts = [sentence.strip() for sentence in sentences if sentence.strip()]
    if not texts:
        return []
    lengths = [len(text) for text in texts]
    max_len = max(lengths)
    if max_len > hard_max:
        # Caller contract: every piece already fits. Refuse to invent a cut.
        return texts
    ceiling = hard_max

    def greedy_count(limit: int) -> int:
        count = 1
        current = 0
        for length in lengths:
            if current and current + 1 + length > limit:
                count += 1
                current = length
            else:
                current = length if not current else current + 1 + length
        return count

    groups_wanted = max(1, greedy_count(ceiling))

    # dp[k][i] = (longest unit, shortest unit) for texts[:i] split into k groups.
    # Ordered so a smaller longest unit wins, and on a tie a larger shortest
    # unit wins — that second key is what stops an even split from degrading
    # into "eight full units and a one-sentence stub", which minimises the
    # longest unit just as well but sounds like a stop.
    n = len(texts)
    prefix = [0] * (n + 1)
    for i, length in enumerate(lengths):
        prefix[i + 1] = prefix[i] + length

    def span(a: int, b: int) -> int:
        """Characters of texts[a:b] joined by single spaces."""
        return prefix[b] - prefix[a] + (b - a - 1)

    def better(candidate: tuple[float, float], current: tuple[float, float]) -> bool:
        if candidate[0] != current[0]:
            return candidate[0] < current[0]
        return candidate[1] > current[1]

    worst = (float("inf"), 0.0)
    dp: list[list[tuple[float, float]]] = [
        [worst] * (n + 1) for _ in range(groups_wanted + 1)
    ]
    cuts = [[0] * (n + 1) for _ in range(groups_wanted + 1)]
    dp[0][0] = (0.0, float("inf"))
    for k in range(1, groups_wanted + 1):
        for end in range(1, n + 1):
            for start in range(k - 1, end):
                width = span(start, end)
                if width > ceiling:
                    # A larger `start` is always narrower, so keep going.
                    continue
                previous = dp[k - 1][start]
                if previous[0] == float("inf") and previous[1] == 0.0:
                    continue
                candidate = (max(previous[0], width), min(previous[1], width))
                if better(candidate, dp[k][end]):
                    dp[k][end] = candidate
                    cuts[k][end] = start

    if dp[groups_wanted][n][0] == float("inf"):  # cannot happen for legal pieces
        return texts

    groups: list[list[str]] = []
    end = n
    for k in range(groups_wanted, 0, -1):
        start = cuts[k][end]
        groups.append(texts[start:end])
        end = start
    groups.reverse()
    return [" ".join(group) for group in groups]


def split_long_text(
    text: str,
    *,
    hard_max: int = UNIT_MAX_CHARS,
) -> list[tuple[str, str]]:
    """Split one paragraph into `(unit_text, pause_kind)` pieces.

    Escalates only as far as it has to, and **prefers the longest unit the model
    can safely render**:

    1. the whole paragraph, if it fits `hard_max` — one generation, so the model
       sets every intra-paragraph breath itself and nothing is spliced inside
       it. This is the common case for ordinary prose at the current ceiling;
    2. sentences cut into the *fewest, most even* units the ceiling allows, so a
       long paragraph is two or three balanced takes rather than four plus a
       stub;
    3. clauses (comma / colon / semicolon / any Unicode dash, **with or without
       following whitespace**) only for a *single sentence* too long to send;
    4. words, then a raw slice, for anything still over `hard_max`.

    Step 4 is what makes the function total. It can always produce a legal unit,
    so a book can never lose a section to a 318-character clause again.

    `hard_max` is the only width control. There is deliberately no packing
    target: a second knob is what made #244 and #245 change the constants without
    changing what a listener heard (see the `UNIT_MAX_CHARS` block).

    The returned pause kind describes what the unit actually ends with, because
    `_trim_silence` strips the model's own trailing silence before a gap is
    inserted — so this label, not the model, decides how long the silence is:

    - `"sentence"` — ends in `. ! ?` : a normal sentence pause.
    - `"clause"` — ends mid-sentence, which only happens when one sentence was
      too long to send as a single unit: a much shorter gap, so a forced break
      reads as punctuation rather than a cut.
    - `"para"` — the paragraph's last unit.

    Concatenating the pieces with single spaces reproduces the input with only
    whitespace normalised; no word is dropped.
    """
    stripped = text.strip()
    if not stripped:
        return []
    if hard_max < 1:
        raise ValueError("hard_max must be at least 1")
    if len(stripped) <= hard_max:
        return [(stripped, "para")]

    def bounded(pieces: list[str]) -> list[str]:
        """Keep only pieces that are legal on their own; recurse on the rest."""
        out: list[str] = []
        for piece in pieces:
            piece = piece.strip()
            if not piece:
                continue
            if len(piece) <= hard_max:
                out.append(piece)
            else:
                # Still too long: go one level finer. A clause split usually
                # succeeds; a single unbroken token falls through to the slice.
                nested = [p for p in _CLAUSE_END.split(piece) if p.strip()]
                if len(nested) > 1:
                    out.extend(bounded(nested))
                else:
                    out.extend(_hard_slice(piece, hard_max))
        return out

    sentences: list[str] = []
    for sentence in _SENTENCE_END.split(stripped):
        if len(sentence) <= hard_max:
            sentences.append(sentence)
        else:
            # One over-long sentence: break it at clause marks, and only then
            # pack, so a forced break is not mistaken for a sentence boundary.
            sentences.extend(bounded(_CLAUSE_END.split(sentence)))

    packed = bounded(_balanced_pack(sentences, hard_max=hard_max))
    if not packed:
        packed = _hard_slice(stripped, hard_max)
    out = [
        (piece, _pause_kind_for(piece))
        for piece in packed[:-1]
    ]
    out.append((packed[-1], "para"))
    return out


#: Terminal marks that make a boundary a real sentence break.
_SENTENCE_TERMINALS = ".!?\u2026"

#: Marks that mean the unit was cut mid-sentence by a length limit.
_CLAUSE_TERMINALS = ",;:\u2014\u2013\u2015\u2012-"


def _pause_kind_for(piece: str) -> str:
    """Pause kind from what a unit ends with, not from how it was produced.

    A unit that ends in `.` deserves a sentence pause whatever path built it;
    a forced clause break deserves less. Deriving it from the text keeps the two
    honest even when the packer happens to end on punctuation.
    """
    trimmed = piece.rstrip()
    if not trimmed:
        return "clause"
    last = trimmed[-1]
    if last in _SENTENCE_TERMINALS:
        return "sentence"
    if last in _CLAUSE_TERMINALS:
        return "clause"
    # A word- or raw-sliced tail: treat it as a clause break, the shorter gap.
    return "clause"



#
# Book `12534aaa` (2026-11-06, VDH clone) drifted *inside* every section and
# reset at each section boundary. That pattern is per-row, not per-container:
# speaker similarity to the reference fell 0.93 -> 0.70 over ~10-12 units, pitch
# fell 15-20 Hz, and the p5-p95 pitch range halved. It then snapped back at the
# next row, where history starts empty again.
#
# The cause is the history chain. With `history[n] = the previous unit's
# generated codes`, unit *n* conditions on unit *n-1*'s take as well as on the
# reference, and each step copies the previous **generated** take slightly more
# than the real speaker. Over 10-12 units that compounds: the voice walks away
# from the reference, then resets when a new row starts with empty history.
#
# The fix is to stop the walk rather than to shorten it. A row keeps its **first**
# unit as the one history turn for every later unit. That first take was
# generated under the strongest conditioning (reference only, no history), so it
# measures ~0.93 against the reference, and every later unit is conditioned one
# hop from it — never one hop from a take that is itself already drifted.
#
# Why not trim each take to a short tail instead: the prompt pairs a text part
# with an audio part. Keeping 1.2 s of audio beside a full paragraph of text is
# a visible mismatch the model has to reconcile, and mismatched prompts are how
# a clone model produces degenerate output. Anchoring keeps the pair exact.
HISTORY_ANCHOR_FIRST = True

#: Sentence gap. Just under the reference's measured 0.42 s median.
#:
#: This is the gap after a unit ending in `. ! ?`. It is **not** applied at every
#: unit boundary any more: `split_long_text` packs several short sentences into
#: one unit, so only every second or third sentence ends a unit.
SPLIT_PAUSE_S = 0.40

#: Gap after a unit cut mid-sentence by the length limit.
#:
#: Only reachable when a single sentence is longer than `UNIT_MAX_CHARS`. Such a
#: break is an artefact of the model's input limit, not a place a narrator would
#: stop, so it gets a shorter gap (0.22 s) than a real sentence. With the
#: 400-char ceiling this path is rare: even the 318-char clause that broke
#: `job 1f0137a1` now fits in one unit.
CLAUSE_PAUSE_S = 0.22

#: Paragraph gap. Scaled from 0.6 s by the same ratio as SPLIT (0.25 -> 0.40),
#: keeping the paragraph:sentence relationship the renders already had, so a
#: chapter break still reads as a bigger break than a sentence pause.
PARAGRAPH_PAUSE_S = 0.96

#: Upper bound on any inserted pause, so a mis-set constant cannot stall a book.
PAUSE_MAX_S = 2.0




def history_anchor(history: list, *, anchor_first: bool = HISTORY_ANCHOR_FIRST) -> list:
    """The history turns to put in a unit's prompt.

    `history` is the row's turns so far, oldest first, as `(text, codes)` pairs.

    With the anchor on (the default) this is **always the row's first turn**, so
    every unit after the first is conditioned one hop from a take that itself had
    no history — the closest thing to the reference the row produced. That is
    what stops the timbre walk of `job 12534aaa`; see the block comment above.

    With it off this is the old upstream behaviour, the last `turns` entries, so
    the change can be rolled back from the contract alone. Pure list handling,
    so it is testable without a GPU.
    """
    if not history:
        return []
    if anchor_first:
        return [history[0]]
    return list(history)


def inserted_pause_s(kind: str) -> float:
    """Seconds of silence inserted after one unit, by pause kind.

    Why three kinds and not two: `_trim_silence` strips each unit's own leading
    and trailing silence before this gap is added, so **this** value is the
    whole gap a listener hears — the model's natural pause between phrases is
    thrown away and replaced. That is why the old single 0.40 s `split` read as a
    cut: every comma boundary got a full sentence-length silence.

    - `"clause"` — a forced mid-sentence break (only when one sentence exceeded
      `hard_max`). 0.22 s: audible as punctuation, not as a stop.
    - `"sentence"` — the unit ends in `. ! ?`. 0.40 s, just under the
      reference's measured 0.42 s median gap.
    - `"para"` — paragraph end. 0.96 s, so a chapter break still reads bigger.
    - `"split"` is kept as an alias for the sentence gap so a caller holding the
      old label (or a stored job) still gets the intended behaviour.

    Unknown kinds get the **clause** gap: a shorter pause is never worse for
    intelligibility than a wrongly long one.
    """
    if kind == "para":
        pause = PARAGRAPH_PAUSE_S
    elif kind in ("sentence", "split", ""):
        pause = SPLIT_PAUSE_S
    else:
        pause = CLAUSE_PAUSE_S
    return max(0.0, min(PAUSE_MAX_S, pause))


def units_summary(units: list[dict]) -> dict:
    """Character shape of the units one section actually went out as.

    Why this travels back in the response: the only way to know whether a take
    was rendered with the long units or the old short ones is to look at the
    build id **and** the units, and a build id alone cannot be seen by anyone
    who only has the job row. `mean_chars`, `max_chars` and the pause-kind
    counts make "this book was rendered in 96 units" a fact rather than an
    inference from the audio.

    Deliberately cheap and pure so it can be asserted without a GPU.
    """
    texts = [str(unit.get("text") or "") for unit in units]
    kinds: dict[str, int] = {}
    for unit in units:
        kind = str(unit.get("pause") or "")
        kinds[kind] = kinds.get(kind, 0) + 1
    lengths = [len(text) for text in texts]
    total = sum(lengths)
    return {
        "count": len(units),
        "chars": total,
        "mean_chars": round(total / len(lengths), 1) if lengths else 0.0,
        "max_chars": max(lengths) if lengths else 0,
        "pause_kinds": kinds,
    }


# ── snapshot identity ───────────────────────────────────────────────────────


def snapshot_fingerprint(parts: dict) -> str:
    """Stable id for the code/config a memory snapshot was captured against.

    Modal invalidates a snapshot when the function's code or configuration
    changes, but it does not tell the container which snapshot it restored.
    Logging this value on every boot makes "the container is running last
    week's weights" visible instead of a mystery quality regression.
    """
    material = "\0".join(f"{k}={parts[k]}" for k in sorted(parts))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:12]


def seed_for_call(job_id: str | None, key: str | None, epoch: int) -> int:
    """Deterministic per-call seed.

    A restored GPU snapshot can hold whatever RNG state the snapshotting
    container had, so two containers restoring the same snapshot would draw
    the same samples. Deriving the seed from the call's own identity (plus an
    explicit epoch for a retry) makes each take independent *and* keeps a
    retry of the same section reproducible.
    """
    material = f"{job_id or ''}\0{key or ''}\0{int(epoch)}"
    digest = hashlib.sha256(material.encode("utf-8")).digest()
    value = int.from_bytes(digest[:8], "big") % (2**31 - 1)
    return value or 1


def warm_reference_wav(seconds: float = 6.0, rate: int = 44100) -> bytes:
    """A deterministic, non-silent 16-bit WAV used to prime the clone path.

    It is not speech, so it proves the codec + prompt path executes, not that
    the clone sounds right. That is exactly what a snapshot warm-up needs: it
    must never depend on a real customer clip being present on the machine
    that builds the snapshot.
    """
    import io
    import wave

    frames = int(max(0.5, seconds) * rate)
    samples = bytearray(frames * 2)
    for i in range(frames):
        t = i / rate
        # Two formants around 180 Hz and 640 Hz with a slow amplitude sweep.
        v = 0.35 * math.sin(2 * math.pi * 180 * t)
        v += 0.22 * math.sin(2 * math.pi * 640 * t + 0.4)
        v += 0.05 * math.sin(2 * math.pi * 2_400 * t)
        v *= 0.6 + 0.4 * math.sin(2 * math.pi * 0.7 * t)
        struct.pack_into("<h", samples, i * 2, int(max(-1.0, min(1.0, v)) * 20000))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(bytes(samples))
    return buf.getvalue()


#: The transcript that goes with {@link warm_reference_wav}. Any non-empty
#: text works because no listener grades it; it only has to survive the
#: non-empty check that Fish's prompt format requires.
WARM_REFERENCE_TEXT = "The river had not moved for three days."


def container_limits(env) -> dict:
    """Autoscaler knobs, read once so health output and the decorator agree.

    Target shape: one frozen app, `min_containers=0`, up to
    `S2C_MAX_CONTAINERS` independent one-GPU containers (default 4 for
    staging, 1 in production until staging is signed off).
    """
    def _int(name: str, default: int, low: int, high: int) -> int:
        try:
            raw = str(env.get(name, "")).strip()
            value = int(raw) if raw else default
        except (TypeError, ValueError):
            value = default
        # A malformed value falls back to the default, not to the floor: a
        # typo in S2C_LANES should not silently mean "one lane".
        if value < low:
            return default if value < 1 else low
        return min(high, value)

    return {
        "min_containers": 0,
        "max_containers": _int("S2C_MAX_CONTAINERS", 1, 1, 8),
        "lanes": _int("S2C_LANES", 4, 1, 8),
        "scaledown_window": _int("S2C_SCALEDOWN", 300, 2, 1200),
        "buffer_containers": _int("S2C_BUFFER_CONTAINERS", 0, 0, 8),
    }


# ── GPU thread affinity ─────────────────────────────────────────────────────


class GpuThreadError(RuntimeError):
    """Work was submitted from a thread that does not own the GPU context."""


class GpuThreadBusy(RuntimeError):
    """The GPU thread already has work queued and this call did not wait."""


class GpuExecutor:
    """Run every CUDA call on one dedicated thread, and nowhere else.

    Why this exists: CUDA state belongs to the thread that initialised it.
    Modal serves a *synchronous* FastAPI endpoint from a fresh worker thread per
    request, and that thread has no handle for a context created elsewhere, so
    the first `cublasCreate` on it fails with `CUBLAS_STATUS_ALLOC_FAILED`.

    A restored snapshot makes this fatal and reproducible, because the context
    is pinned to the thread that owned it when the image was captured. But the
    mismatch is not restore-specific: on a *freshly compiled* container the
    context is owned by whichever thread ran `torch.cuda.init()`, which was
    never the request thread either. So the same latent bug existed before any
    snapshot was involved — it just had no warm-up to blame. Treat both boot
    paths as affected and test both (see `docs/s2-gpu-staging-runbook.md` step
    0a).

    The fix is to own one thread, do all GPU work there (including the warm-up
    that gets snapshotted), and have request handlers submit to it. Nothing on
    a request thread may touch CUDA.

    Only one call may be in flight, which is also what the model wants: the
    decode loop already uses the full batch and the whole GPU.

    The class is stdlib-only on purpose so the contract can be tested by
    submitting CPU work and checking thread identity.
    """

    def __init__(self, name: str = "s2-gpu") -> None:
        self._name = name
        self._requests: queue.Queue = queue.Queue()
        self._thread: threading.Thread | None = None
        self._owner_ident: int | None = None
        self._busy = threading.Lock()
        self._ready = threading.Event()
        self._init_error: BaseException | None = None
        self._closed = False
        self.jobs_done = 0
        self.init_s: float | None = None

    # ── lifecycle ──────────────────────────────────────────────────────────

    def start(self, init: Callable[[], Any] | None = None, *, timeout: float = 1800.0):
        """Start the thread and run `init` on it.

        `init` is where CUDA is first touched, so it must be called from
        `@modal.enter(snap=True)`: the context then belongs to this thread
        before the snapshot is taken, and survives the restore on this thread
        and no other.
        """
        if self._thread is not None:
            return self
        started = time.time()
        self._thread = threading.Thread(
            target=self._run, name=self._name, daemon=True
        )
        self._thread.start()
        if init is not None:
            try:
                self.submit(init, timeout=timeout)
            except BaseException as err:  # surface a broken GPU at boot
                self._init_error = err
                raise
        self.init_s = round(time.time() - started, 2)
        self._ready.set()
        return self

    def close(self) -> None:
        self._closed = True
        self._requests.put(None)

    @property
    def thread_ident(self) -> int | None:
        return self._owner_ident

    def owns_gpu(self) -> bool:
        """True only on the thread that owns the context. Cheap pre-flight."""
        return self._owner_ident is not None and threading.get_ident() == self._owner_ident

    def assert_not_gpu_thread(self) -> None:
        """Request handlers call this to fail fast instead of guessing."""
        if self.owns_gpu():
            raise GpuThreadError(
                "CUDA work must not run on the GPU owner thread from a handler"
            )

    # ── submission ─────────────────────────────────────────────────────────

    def submit(
        self,
        fn: Callable[[], Any],
        *,
        queue_timeout: float | None = None,
        timeout: float | None = None,
    ):
        """Run `fn` on the GPU thread and return its result.

        Two separate clocks, because they answer different questions:

        - `queue_timeout` — how long to wait for the lane to be free. A request
          handler wants this short (or zero) so a busy container can answer
          "try another lane" instead of holding a connection open.
        - `timeout` — how long the job itself may take. A batch legitimately
          runs for minutes, so this defaults to unbounded.
        """
        if self._thread is None:
            raise GpuThreadError("GPU thread is not running")
        if self._closed:
            raise GpuThreadError("GPU thread is closed")
        if self._init_error is not None:
            raise GpuThreadError(f"GPU thread failed to start: {self._init_error}")
        if queue_timeout is None:
            acquired = self._busy.acquire()
        else:
            acquired = self._busy.acquire(timeout=queue_timeout)
        if not acquired:
            raise GpuThreadBusy("GPU thread is busy with another call")
        try:
            box: dict[str, Any] = {}
            done = threading.Event()
            self._requests.put((fn, box, done))
            if not done.wait(timeout):
                raise TimeoutError("GPU thread call timed out")
            if "error" in box:
                raise box["error"]
            return box.get("value")
        finally:
            self._busy.release()

    def _run(self) -> None:
        self._owner_ident = threading.get_ident()
        while True:
            item = self._requests.get()
            if item is None:
                return
            fn, box, done = item
            try:
                box["value"] = fn()
                self.jobs_done += 1
            except BaseException as err:  # propagate to the submitter
                box["error"] = err
            finally:
                done.set()


# ── boot provenance ────────────────────────────────────────────────────────

#: What a container can honestly say about its own boot. See {@link boot_kind}.
#:
#: There is deliberately no `compiled` value. A container cannot prove it
#: compiled rather than restored, and claiming so is how the earlier bug
#: reported every real restore as a compile.
BOOT_RESTORED = "restored"
BOOT_UNKNOWN = "unknown"

#: A snapshot restored on the *same* worker keeps a forward-moving monotonic
#: clock, so only a genuinely different host proves a restore. This much
#: backwards movement is far beyond any clock adjustment: `CLOCK_MONOTONIC` does
#: not step at all, and NTP corrections are sub-second.
MONOTONIC_RESTORE_SLACK_S = 1.0


def boot_kind(
    *,
    snap_monotonic: float | None,
    now_monotonic: float,
) -> str:
    """Say `restored` only when that can be proven, else `unknown`.

    Two earlier attempts read a restore out of something that does not actually
    differ, and both were wrong the same way — they overstated what the
    container knows:

    1. `now_wall - compiled_at`. `compiled_at` is frozen *inside* the snapshot,
       so a restore (minutes later) looked huge and a compile (microseconds
       apart) looked small. Exactly inverted.
    2. Process id. A restore was assumed to resume in a new process; staging
       showed Modal runs the app as **pid 2 both before and after**, so the
       comparison was always equal and every real restore reported `compiled`.

    What can differ: a restore resumes the image on a *different worker*, and
    `time.monotonic()` is that host's uptime. If it went **backwards** past the
    value captured while snapshotting, the clock belongs to a different, younger
    host — that is a sound proof of a restore, and it is one-directional.

    The converse does not hold. A restore onto a host that has been up longer
    than the builder moves the clock forward just like a compile does, so
    "forward" proves nothing. This returns `unknown` in that case rather than
    guessing, because guessing is precisely the bug being fixed.

    Modal itself logs `Snapshot created. Restoring Function from memory
    snapshot.` for every restore, and that platform log — plus a client-side
    wall clock for the first cold call — is the authoritative evidence. A
    container cannot read its own platform log, and cannot measure its own
    restore: it did not exist for most of it.
    """
    if snap_monotonic is None:
        return BOOT_UNKNOWN
    if float(now_monotonic) + MONOTONIC_RESTORE_SLACK_S < float(snap_monotonic):
        return BOOT_RESTORED
    return BOOT_UNKNOWN


def snapshot_age_s(
    *,
    snap_wall: float | None,
    now_wall: float,
    boot: str,
) -> float | None:
    """Build age, and only when the two clocks are known to be comparable.

    `snap_wall` is frozen inside the snapshot, so on a *restored* container its
    distance from `now_wall` is the age of the build — two wall clocks on
    different hosts, which is exactly the number wanted.

    On an `unknown` boot the same subtraction can mix a snapshot's mark with a
    different host's wall clock, so it may be meaningless (or negative). Rather
    than print a guess as a measurement, return None.

    This is never a restore duration: nothing inside the container can measure
    how long restoring took.
    """
    if snap_wall is None:
        return None
    if boot != BOOT_RESTORED:
        return None
    age = now_wall - snap_wall
    if age < 0:
        return None
    return round(age, 1)


def boot_budget_s(kind: str, *, restore_target_s: float = 90.0) -> float:
    """How long a single call may wait for this kind of boot.

    An unknown boot is treated like a restore: the alternative is aborting a
    boot that may well have been a successful restore. A compile is not a
    budget a book is allowed to wait — see `placement_kind`.
    """
    return restore_target_s


#: Wall clock a book may spend on one cold placement. A restore is ~30–90 s.
RESTORE_WALL_S = 150.0
#: At or above this, the call built a snapshot. An 8 min compile is well past
#: it, and `boot=` is not an input: that label is often wrong (pid 2 on a restore).
COMPILE_WALL_S = 300.0


def placement_kind(
    wall_s: float, *, restore_s: float = RESTORE_WALL_S, compile_s: float = COMPILE_WALL_S
) -> str:
    """Classify a cold call by wall clock.

    `restore` finished inside the budget a book is allowed to wait.
    `compile` ran long enough that this call built a snapshot. That is an
    off-path RPC outcome, never a book deadline.
    `slow` is past a restore and short of a compile: not a proved restore.

    `boot=` is deliberately not an argument. A container cannot prove it
    compiled, and a restored container often cannot prove it restored.
    """
    wall = float(wall_s)
    if wall >= compile_s:
        return "compile"
    if wall <= restore_s:
        return "restore"
    return "slow"


