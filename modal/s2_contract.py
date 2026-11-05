"""Pure helpers shared by the S2-Pro clone service and its staging script.

Nothing here imports `modal`, `torch` or `fastapi`, so it can be imported by
unit tests on a laptop and by the GPU image alike. That keeps the request-
validation rules (which is where an empty reference clip used to kill a
snapshot warm-up) testable without a GPU.

Units are bytes, seconds and whole characters throughout.
"""

from __future__ import annotations

import array
import hashlib
import math
import struct
import sys

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


def validate_reference_audio(audio: bytes | None) -> dict:
    """Raise {@link ReferenceClipError} unless this clip can prompt a clone.

    The previous warm-up passed an empty file, so `torchaudio.load` raised and
    the snapshot build failed with a stack trace that did not name the cause.
    Every rule here reports what is wrong with the clip.
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
    stats = reference_stats(audio)
    if stats["seconds"] is not None and stats["seconds"] < REFERENCE_MIN_SECONDS:
        raise ReferenceClipError(
            f"reference clip is {stats['seconds']}s; need at least {REFERENCE_MIN_SECONDS}s"
        )
    rms = stats["rms"]
    if rms is not None and rms < REFERENCE_MIN_RMS:
        raise ReferenceClipError(
            f"reference clip is silent (rms {rms}); need at least {REFERENCE_MIN_RMS}"
        )
    if stats["format"] == "wav" and stats["distinct"] < REFERENCE_MIN_DISTINCT_SAMPLES:
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
