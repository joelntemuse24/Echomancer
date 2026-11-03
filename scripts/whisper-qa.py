#!/usr/bin/env python3
"""
Self-hosted Whisper for section QA.

Reads audio on stdin, writes one JSON object to stdout:

    {"ok": true, "text": "...", "model": "base", "audioSec": 221.4, "sttSec": 6.3}
    {"ok": false, "error": "..."}

Audio is decoded by ffmpeg to 16 kHz mono PCM first. `faster-whisper`'s own
loader goes through PyAV, whose API has moved between releases; ffmpeg is
already a hard dependency of this project, so using it removes a version
coupling and honours the same `FFMPEG_PATH` the rest of the worker uses.

Model choice (`TTS_QA_WHISPER_MODEL`, default `base`):
  base  int8  ~5% WER on neural TTS, RTF ~0.02 on 4 vCPU
  small int8  ~6% WER, RTF ~0.05

Both are far above realtime on this hardware, so `small` is affordable if the
worker is idle-heavy. `base` is the default because QA latency is on the
section's critical path.

Nothing here is CUDA-aware: the Contabo worker has no GPU.
"""

import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time

MODEL = os.environ.get("TTS_QA_WHISPER_MODEL", "base").strip() or "base"
COMPUTE = os.environ.get("TTS_QA_WHISPER_COMPUTE", "int8").strip() or "int8"
BEAM = int(os.environ.get("TTS_QA_WHISPER_BEAM", "1") or 1)
TARGET_RATE = 16000


def fail(message):
    sys.stdout.write(json.dumps({"ok": False, "error": str(message)[:400]}))
    sys.stdout.flush()
    sys.exit(0)


def ffmpeg_bin():
    return os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg") or "ffmpeg"


def decode_to_pcm(raw):
    """ffmpeg -i pipe:0 -f s16le -ar 16k -ac 1 pipe:1"""
    proc = subprocess.run(
        [ffmpeg_bin(), "-hide_banner", "-loglevel", "error",
         "-i", "pipe:0", "-f", "s16le", "-ar", str(TARGET_RATE), "-ac", "1", "pipe:1"],
        input=raw,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=120,
    )
    if proc.returncode != 0 or not proc.stdout:
        raise RuntimeError("decode failed: " + proc.stderr.decode("utf-8", "ignore")[:200])
    return proc.stdout


def pcm_to_float(pcm):
    import numpy as np
    count = len(pcm) // 2
    if count == 0:
        raise RuntimeError("decoded audio is empty")
    return np.frombuffer(pcm[: count * 2], dtype="<i2").astype("float32") / 32768.0


def main():
    raw = sys.stdin.buffer.read()
    if not raw:
        fail("no audio on stdin")

    started = time.time()
    try:
        audio = pcm_to_float(decode_to_pcm(raw))
    except Exception as exc:  # noqa: BLE001 - reported, never raised
        fail(exc)
        return

    duration = len(audio) / float(TARGET_RATE)
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # noqa: BLE001
        fail("faster-whisper not installed: %s" % exc)
        return

    try:
        load_started = time.time()
        model = WhisperModel(MODEL, device="cpu", compute_type=COMPUTE)
        load_sec = time.time() - load_started
        stt_started = time.time()
        segments, _info = model.transcribe(
            audio,
            language="en",
            beam_size=BEAM,
            # VAD drops the leading/trailing silence a TTS turn may carry, and
            # prevents Whisper's worst failure mode (looping on near-silence).
            vad_filter=True,
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        stt_sec = time.time() - stt_started
    except Exception as exc:  # noqa: BLE001
        fail("transcribe failed: %s" % exc)
        return

    sys.stdout.write(json.dumps({
        "ok": True,
        "text": text,
        "model": MODEL,
        "compute": COMPUTE,
        "audioSec": round(duration, 3),
        "loadSec": round(load_sec, 3),
        "sttSec": round(stt_sec, 3),
        "rtf": round(stt_sec / duration, 4) if duration > 0 else None,
        "wallSec": round(time.time() - started, 3),
    }))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
