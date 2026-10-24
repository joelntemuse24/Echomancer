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

# Phoneme budget per model call. Long sentences are split at a space and short
# sentences are packed together so every call clears the training floor.
MAX_PHONEMES = 510
MIN_STANDALONE_PHONEMES = 35
MERGE_MAX_PHONEMES = 140

# Loudness match after synthesis: lift quiet takes toward a steady RMS without
# letting the peak run past the clip guard.
TARGET_ACTIVE_RMS = 0.145
MAX_PEAK = 0.85

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


def _packed_phoneme_chunks(tts, text):
    """Yield phoneme strings sized for the model: sentences packed per paragraph.

    Sentences below the 6-word training floor join a neighbour so the model
    keeps a steady rate instead of restarting on every fragment.
    """
    for paragraph in re.split(r"\n+", text.strip()):
        if not paragraph.strip():
            continue
        items = []
        for sentence in re.split(r"(?<=[.!?…])\s+", paragraph.strip()):
            if not sentence.strip():
                continue
            items.extend(_split_long_phonemes(_phonemize_clean(tts, sentence)))

        merged = []
        i = 0
        while i < len(items):
            ps = items[i]
            if not ps:
                i += 1
                continue
            if merged:
                prev = merged[-1]
                if (
                    len(ps) < MIN_STANDALONE_PHONEMES
                    and len(prev) + 1 + len(ps) <= MERGE_MAX_PHONEMES
                ):
                    merged[-1] = re.sub(r"\.+$", ",", prev) + " " + ps
                    i += 1
                    continue
                merged.append(ps)
                i += 1
                continue
            nxt = items[i + 1] if i + 1 < len(items) else ""
            if (
                len(ps) < MIN_STANDALONE_PHONEMES
                and nxt
                and len(ps) + 1 + len(nxt) <= MERGE_MAX_PHONEMES
            ):
                merged.append(re.sub(r"\.+$", ",", ps) + " " + nxt)
                i += 2
                continue
            merged.append(ps)
            i += 1

        for ps in merged:
            if ps:
                yield ps


def _synth(text, speed):
    """Run the model in a worker process. Returns float32 mono audio at 24 kHz."""
    if hasattr(_tts, "generate_from_phonemes") and hasattr(_tts, "phonemize"):
        parts = [
            _tts.generate_from_phonemes(ps, speed)
            for ps in _packed_phoneme_chunks(_tts, text)
        ]
        audio = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
    else:
        audio = _tts(text, speed=speed)
    return np.asarray(audio, dtype=np.float32).reshape(-1)


def _pcm_s16le(audio):
    audio = np.nan_to_num(audio, nan=0.0, posinf=0.0, neginf=0.0).astype(
        np.float32, copy=False
    )
    audio = audio.reshape(-1)
    if audio.size > 0:
        fl = int(0.025 * SAMPLE_RATE)
        frames = audio.size // fl
        cur_rms = 0.0
        if frames > 0:
            block = audio[: frames * fl].reshape(frames, fl)
            frame_rms = np.sqrt(np.mean(block * block, axis=1))
            active = frame_rms[frame_rms > 0.0056]
            if active.size:
                cur_rms = float(np.sqrt(np.mean(active * active)))
        peak = float(np.max(np.abs(audio)))
        gain = min(
            TARGET_ACTIVE_RMS / max(cur_rms, 1e-4),
            MAX_PEAK / max(peak, 1e-4),
        )
        audio = audio * min(2.5, max(1.0, gain))
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

            pcm = _pcm_s16le(audio)
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
