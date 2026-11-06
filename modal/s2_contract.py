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


