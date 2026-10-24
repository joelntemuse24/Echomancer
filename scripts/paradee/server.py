#!/usr/bin/env python3
"""HTTP sidecar for the Paradee v1.1 fp32 ONNX text-to-speech model.

Runs a small pool of worker processes (each holds one warm Paradee session) and
serves two routes:

    GET  /health      -> {"ok": true, "procs": N}
    POST /synthesize  -> audio/mpeg or audio/wav

POST body: {"text": str, "speed": float, "format": "mp3" | "wav"}

Set PARADEE_SECRET to require "Authorization: Bearer <secret>" on POST.
"""

import hmac
import io
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import wave
import zlib
from concurrent.futures import ProcessPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

import numpy as np

SAMPLE_RATE = 24000
MAX_TEXT_CHARS = 20000
MAX_BODY_BYTES = 4 * 1024 * 1024
MIN_SPEED = 0.5
MAX_SPEED = 2.0
DEFAULT_SPEED = 1.0
DEFAULT_FORMAT = "mp3"

# Phoneme budget per model call. The graph takes 512 positions, two of which are
# pad tokens. A paragraph is offered as one call whenever it fits, because the
# model then plans intonation across the whole paragraph: sentence gaps land at
# 315-416 ms instead of the 330/810 ms alternation it produces when every
# sentence restarts the decoder (measured on the worker, 2026-10-24).
MAX_PHONEMES = 510
# Floor for a sentence read on its own. Only reached when a paragraph has to be
# split across several calls; below this the model resumes at an unstable rate.
MIN_STANDALONE_PHONEMES = 35
# A shorter sentence still joins a neighbour's call rather than paying a fresh
# 300 ms lead-in and 450 ms tail.
MERGE_MAX_PHONEMES = 480

# Per-call silence trim, in milliseconds. The model wraps every take in silence
# that scales with the text, so a generate-per-sentence pipeline carries ~720 ms
# of dead air per call. Keep a natural amount and handwrite the join:
LEAD_SILENCE_KEEP_MS = 40
TAIL_SILENCE_KEEP_MS = 90
# Gap inserted between two calls that continue a paragraph.
SENTENCE_GAP_MS = 300
# Gap inserted between paragraphs (and before a following heading line).
PARAGRAPH_GAP_MS = 620
# Silence below this fraction of the take's peak counts as padding, not speech.
SILENCE_FLOOR = 10 ** (-45.0 / 20.0)

# Room tone laid under the whole take at a fixed low level. The model emits
# digital zeros in every pause, which reads as a gated, cut-and-splice
# recording on headphones even when the timing is right. A dither-level noise
# bed costs nothing perceptually except the sense of an open microphone.
ROOM_TONE_DBFS = -72.0
# Short raised-cosine fades where trimmed speech meets the room tone, so the
# boundaries do not click.
EDGE_FADE_MS = 4

# Loudness match after synthesis: lift quiet takes toward a steady RMS without
# letting the peak run past the clip guard.
TARGET_ACTIVE_RMS = 0.145
MAX_PEAK = 0.85
# Cap on the makeup gain applied to one call. The model is already consistent
# between calls; a large lift here would pump one paragraph against the next.
MAX_CALL_GAIN = 1.35

DEFAULT_MODEL = "/opt/echomancer/paradee/paradee_v1.1_polish_fp32.onnx"
DEFAULT_CONFIG = "/opt/echomancer/paradee/config.json"

FFMPEG_MP3_CMD = [
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "s16le",
    "-ar",
    "24000",
    "-ac",
    "1",
    "-i",
    "pipe:0",
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "128k",
    "-f",
    "mp3",
    "pipe:1",
]

_tts = None


def _init_worker(model_path, config_path):
    """Load one Paradee session per worker and pay the first-call cost up front."""
    global _tts
    try:
        os.nice(5)
    except OSError as exc:
        print(f"[paradee] worker {os.getpid()}: os.nice(5) failed: {exc}", file=sys.stderr, flush=True)

    from paradee.tts import Paradee

    _tts = Paradee(model_path=model_path, config_path=config_path, threads=1)
    _tts("Warm up.")
    print(f"[paradee] worker {os.getpid()} warm", file=sys.stderr, flush=True)


def _ping(_):
    """Trivial task used at startup to force every worker to initialise."""
    return os.getpid()


def _phonemize_clean(tts, sentence):
    """Phonemize one sentence, fixing the greeting dash and a Misaki OOV."""
    sentence = re.sub(r"(?i)\b(hi|hello|hey)\s*[—–-]+\s*", r"\1, ", sentence)
    ps = tts.phonemize(sentence)
    return ps.replace("ˈɛkəmənsəɹ", "ˈɛkOmˌænsəɹ")


def _split_long_phonemes(ps):
    """Split a phoneme string longer than MAX_PHONEMES at the last space."""
    out = []
    while len(ps) > MAX_PHONEMES:
        cut = ps.rfind(" ", 0, MAX_PHONEMES + 1)
        if cut <= 0:
            cut = MAX_PHONEMES
        out.append(ps[:cut].strip())
        ps = ps[cut:].strip()
    if ps:
        out.append(ps)
    return out


class Chunk:
    """One model call: phonemes plus where it sits in the paragraph flow."""

    __slots__ = ("phonemes", "gap_before_ms")

    def __init__(self, phonemes, gap_before_ms):
        self.phonemes = phonemes
        self.gap_before_ms = gap_before_ms


def _sentence_phonemes(tts, sentence):
    """Phonemize a sentence and split it if it alone exceeds the graph budget."""
    return _split_long_phonemes(_phonemize_clean(tts, sentence))


def plan_chunks(tts, text):
    """Lay out model calls for this request.

    A paragraph is read in one call whenever its phonemes fit MAX_PHONEMES.
    When it does not, consecutive sentences are packed up to the budget and the
    remainder starts a new call. A short sentence (< MIN_STANDALONE_PHONEMES)
    that would otherwise be alone joins a neighbour where there is room.

    Each call records the silence to place before it: SENTENCE_GAP_MS inside a
    paragraph, PARAGRAPH_GAP_MS at a paragraph break. The caller trims the
    model's own padding and inserts these gaps, so a paragraph break sounds
    like a break instead of a longer sentence pause.
    """
    chunks = []
    paragraphs = [p.strip() for p in re.split(r"\n+", text.strip()) if p.strip()]

    for p_index, paragraph in enumerate(paragraphs):
        # Phonemized per sentence so an over-budget sentence can be split
        # cleanly, then packed back into as few calls as the graph allows.
        pieces = []
        for sentence in re.split(r"(?<=[.!?…])\s+", paragraph):
            if sentence.strip():
                pieces.extend(ps for ps in _sentence_phonemes(tts, sentence) if ps)

        calls, current, current_len = [], [], 0
        for ps in pieces:
            if current:
                fits = current_len + 1 + len(ps) <= MAX_PHONEMES
                # A short fragment is worth keeping on the same call even if
                # that slightly exceeds the comfort budget, up to the hard cap.
                if not fits and len(ps) < MIN_STANDALONE_PHONEMES:
                    fits = current_len + 1 + len(ps) <= MERGE_MAX_PHONEMES
                if not fits:
                    calls.append(current)
                    current, current_len = [], 0
            current.append(ps)
            current_len += (1 if current_len else 0) + len(ps)
        if current:
            calls.append(current)

        # A long paragraph that just spills over leaves a stub final call, and
        # a stub restarts the decoder's prosody for one short phrase. Hand
        # sentences back to the stub until it can stand on its own.
        while len(calls) > 1:
            stub = calls[-1]
            prev = calls[-2]
            stub_len = len(" ".join(stub))
            if stub_len >= MIN_STANDALONE_PHONEMES or len(prev) <= 1:
                break
            moved = prev[-1]
            if len(" ".join(prev[:-1])) < MIN_STANDALONE_PHONEMES:
                break
            calls[-2] = prev[:-1]
            calls[-1] = [moved] + stub

        for call_index, call in enumerate(calls):
            if p_index == 0 and call_index == 0:
                gap = 0
            elif call_index == 0:
                gap = PARAGRAPH_GAP_MS
            else:
                gap = SENTENCE_GAP_MS
            chunks.append(Chunk(" ".join(call), gap))
    return chunks


def _active_rms(audio, frame_ms=25):
    """RMS of the frames that carry speech, which ignores the padding."""
    frame = max(1, int(frame_ms * SAMPLE_RATE / 1000))
    usable = audio.size // frame
    if usable == 0:
        return 0.0
    blocks = audio[: usable * frame].reshape(usable, frame)
    per_frame = np.sqrt(np.mean(blocks * blocks, axis=1))
    active = per_frame[per_frame > 0.0056]
    if active.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(active * active)))


def trim_padding(audio, lead_keep_ms=LEAD_SILENCE_KEEP_MS, tail_keep_ms=TAIL_SILENCE_KEEP_MS):
    """Drop the model's leading and trailing silence, keeping a short bed.

    The model pads every call, and the amount grows with the text, so this is
    measured per take rather than assumed.
    """
    audio = np.asarray(audio, dtype=np.float32).reshape(-1)
    if audio.size == 0:
        return audio
    peak = float(np.max(np.abs(audio))) or 0.0
    if peak <= 0.0:
        return np.zeros(0, dtype=np.float32)
    loud = np.flatnonzero(np.abs(audio) > peak * SILENCE_FLOOR)
    if loud.size == 0:
        return np.zeros(0, dtype=np.float32)
    lead = max(0, loud[0] - int(lead_keep_ms * SAMPLE_RATE / 1000))
    tail = min(audio.size, loud[-1] + 1 + int(tail_keep_ms * SAMPLE_RATE / 1000))
    return audio[lead:tail]


def _apply_edge_fades(audio, fade_ms=EDGE_FADE_MS):
    """Raised-cosine fades so trimmed speech does not start or stop on a click."""
    n = min(int(fade_ms * SAMPLE_RATE / 1000), audio.size // 2)
    if n <= 0:
        return audio
    ramp = 0.5 - 0.5 * np.cos(np.linspace(0.0, np.pi, n)).astype(np.float32)
    audio = audio.copy()
    audio[:n] *= ramp
    audio[-n:] *= ramp[::-1]
    return audio


def _silence(ms):
    return np.zeros(int(ms * SAMPLE_RATE / 1000), dtype=np.float32)


def _synth(text, speed):
    """Run the model in a worker process. Returns float32 mono audio at 24 kHz."""
    if hasattr(_tts, "generate_from_phonemes") and hasattr(_tts, "phonemize"):
        chunks = plan_chunks(_tts, text)
        if not chunks:
            return np.zeros(0, dtype=np.float32)

        takes = []
        for chunk in chunks:
            raw = np.asarray(
                _tts.generate_from_phonemes(chunk.phonemes, speed), dtype=np.float32
            ).reshape(-1)
            take = _apply_edge_fades(trim_padding(raw))
            if take.size:
                # Even out call-to-call level without letting one take pump.
                level = _active_rms(take)
                if level > 1e-4:
                    gain = min(MAX_CALL_GAIN, max(1.0, TARGET_ACTIVE_RMS / level))
                    take = take * min(
                        gain, MAX_PEAK / max(float(np.max(np.abs(take))), 1e-4)
                    )
            takes.append((chunk.gap_before_ms, take))

        parts = []
        for gap_ms, take in takes:
            if not take.size:
                continue
            if gap_ms > 0 and parts:
                parts.append(_silence(gap_ms))
            parts.append(take)
        audio = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
    else:
        audio = np.asarray(_tts(text, speed=speed), dtype=np.float32).reshape(-1)
    return audio.astype(np.float32, copy=False)


def _room_tone(size, seed):
    """Dither-level noise so pauses are never digital zeros.

    Seeded per passage so the same text always gets the same bed.
    """
    if size <= 0:
        return np.zeros(0, dtype=np.float32)
    rng = np.random.default_rng(seed)
    level = 10 ** (ROOM_TONE_DBFS / 20.0)
    noise = rng.standard_normal(size).astype(np.float32) * level
    # Cheap spectral tilt: cumsum of white noise is brown-ish; mix toward it so
    # the bed reads as air rather than as a hiss.
    tilt = np.cumsum(noise, dtype=np.float32)
    tilt *= level / max(float(np.std(tilt)), 1e-9)
    bed = 0.6 * noise + 0.4 * tilt
    return bed.astype(np.float32)


def add_room_tone(audio, seed):
    """Lay the bed under the take, including the pauses and the head/tail."""
    if audio.size == 0:
        return audio
    bed = _room_tone(audio.size, seed)
    return (audio + bed).astype(np.float32, copy=False)


def _pcm_s16le(audio, seed=0):
    """Lift the take to a steady RMS, lay the room tone, then quantise."""
    audio = np.nan_to_num(audio, nan=0.0, posinf=0.0, neginf=0.0).astype(
        np.float32, copy=False
    )
    audio = audio.reshape(-1)
    if audio.size > 0:
        cur_rms = _active_rms(audio)
        peak = float(np.max(np.abs(audio)))
        gain = min(
            TARGET_ACTIVE_RMS / max(cur_rms, 1e-4),
            MAX_PEAK / max(peak, 1e-4),
        )
        # One gain for the whole take, applied before the bed: scaling the
        # noise with the speech would make quiet passages hiss.
        audio = audio * min(2.5, max(1.0, gain))
        audio = add_room_tone(audio, seed)
    clipped = np.clip(audio, -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()


def _encode_wav(pcm):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm)
    return buf.getvalue()


def _encode_mp3(pcm):
    proc = subprocess.run(
        FFMPEG_MP3_CMD,
        input=pcm,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if proc.returncode != 0 or not proc.stdout:
        detail = proc.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(f"ffmpeg failed (exit {proc.returncode}): {detail or 'no output'}")
    return proc.stdout


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    server_version = "paradee-sidecar/1.1"
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/health":
            self._send_json(200, {"ok": True, "procs": self.server.procs})
            return
        if path == "/synthesize":
            self._send_json(405, {"error": "use POST"})
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self):
        path = urlsplit(self.path).path
        if path != "/synthesize":
            self._send_json(404, {"error": "not found"})
            return

        chars = 0
        started = time.monotonic()
        try:
            self._check_auth()
            text, speed, fmt = self._read_request()
            chars = len(text)

            audio = self.server.pool.submit(_synth, text, speed).result()
            seconds = audio.size / SAMPLE_RATE

            # Seeded from the text: the bed is fixed for a given passage, so it
            # cannot drift between retries or mask a repeated section. The
            # model's own output still varies slightly call to call.
            pcm = _pcm_s16le(audio, seed=zlib.crc32(text.encode("utf-8")))
            if fmt == "wav":
                body, content_type = _encode_wav(pcm), "audio/wav"
            else:
                body, content_type = _encode_mp3(pcm), "audio/mpeg"

            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Audio-Seconds", f"{seconds:.3f}")
            self.end_headers()
            self.wfile.write(body)
            self._log("ok", chars, seconds, time.monotonic() - started)
        except RequestError as exc:
            self._send_json(exc.status, {"error": exc.message})
            self._log(f"error {exc.status}", chars, 0.0, time.monotonic() - started)
        except Exception as exc:  # model, ffmpeg, socket or client failure
            self._send_json(500, {"error": f"{type(exc).__name__}: {exc}"})
            self._log("error 500", chars, 0.0, time.monotonic() - started)

    def _check_auth(self):
        secret = self.server.secret
        if not secret:
            return
        header = self.headers.get("Authorization", "")
        expected = f"Bearer {secret}"
        if not hmac.compare_digest(header.encode("utf-8"), expected.encode("utf-8")):
            raise RequestError(401, "unauthorized")

    def _read_request(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise RequestError(400, "invalid Content-Length")
        if length <= 0:
            raise RequestError(400, "empty request body")
        if length > MAX_BODY_BYTES:
            raise RequestError(413, "request body too large")

        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise RequestError(400, "body must be JSON")
        if not isinstance(payload, dict):
            raise RequestError(400, "body must be a JSON object")

        text = payload.get("text")
        if not isinstance(text, str):
            raise RequestError(400, "text must be a string")
        if len(text) > MAX_TEXT_CHARS:
            raise RequestError(413, f"text exceeds {MAX_TEXT_CHARS} characters")
        if not text.strip():
            raise RequestError(400, "text is empty")

        speed = payload.get("speed", DEFAULT_SPEED)
        try:
            speed = float(speed)
        except (TypeError, ValueError):
            raise RequestError(400, "speed must be a number")
        if speed != speed:  # NaN
            raise RequestError(400, "speed must be a number")
        speed = min(max(speed, MIN_SPEED), MAX_SPEED)

        fmt = payload.get("format", DEFAULT_FORMAT)
        if not isinstance(fmt, str) or fmt.lower() not in ("mp3", "wav"):
            raise RequestError(400, "format must be mp3 or wav")
        fmt = fmt.lower()

        return text, speed, fmt

    def _send_json(self, status, payload):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # The request body may not have been read (auth, size, bad JSON), so
        # do not try to reuse this connection.
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _log(self, status, chars, seconds, wall):
        print(
            f"[paradee] {status} chars={chars} audio={seconds:.2f}s wall={wall:.2f}s",
            flush=True,
        )

    def log_message(self, fmt, *args):
        # Default access logging is noisy next to the per-request line.
        pass


class SidecarServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, pool, procs, secret):
        super().__init__(address, Handler)
        self.pool = pool
        self.procs = procs
        self.secret = secret


def _env_int(name, default):
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        raise SystemExit(f"{name} must be an integer, got {raw!r}")


def main():
    host = os.environ.get("PARADEE_HOST", "127.0.0.1")
    port = _env_int("PARADEE_PORT", 8791)
    model_path = os.environ.get("PARADEE_MODEL", DEFAULT_MODEL)
    config_path = os.environ.get("PARADEE_CONFIG", DEFAULT_CONFIG)
    procs = max(1, _env_int("PARADEE_PROCS", 3))
    secret = os.environ.get("PARADEE_SECRET") or None

    for label, path in (("PARADEE_MODEL", model_path), ("PARADEE_CONFIG", config_path)):
        if not os.path.isfile(path):
            raise SystemExit(f"{label} not found: {path}")

    pool = ProcessPoolExecutor(
        max_workers=procs,
        initializer=_init_worker,
        initargs=(model_path, config_path),
    )

    # Touch the pool once per worker so every session is loaded before /health
    # reports ready.
    for _ in pool.map(_ping, range(procs)):
        pass

    server = SidecarServer((host, port), pool, procs, secret)

    def _stop(signum, frame):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    print(f"[paradee] listening on http://{host}:{port} procs={procs}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        pool.shutdown(wait=False, cancel_futures=True)
        print("[paradee] stopped", flush=True)


if __name__ == "__main__":
    main()
