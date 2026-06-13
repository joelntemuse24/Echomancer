"""Find where MeanVC fails vs F5 fallback by text length."""
from __future__ import annotations

import base64
import subprocess
import tempfile
from pathlib import Path

import httpx

VOICE = Path(r"C:\Users\ntemu\Downloads\Ntw-enhanced-v2.wav")
URL = "https://ntemusejoel--echomancer-hybrid-tts-fastapi-app.modal.run/generate_batch"

with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
    out = tmp.name
subprocess.run(
    ["ffmpeg", "-y", "-i", str(VOICE), "-ss", "0", "-t", "15", "-ac", "1", "-ar", "24000", out],
    check=True,
    capture_output=True,
)
voice_b64 = base64.b64encode(Path(out).read_bytes()).decode()
Path(out).unlink(missing_ok=True)

sentence = (
    "Imagine that the natural sciences were to suffer the effects of a catastrophe. "
)

for n in [1, 2, 4, 6, 8, 10, 12]:
    text = sentence * n
    payload = {
        "texts": [text],
        "reference_audio_base64": voice_b64,
        "qwen_speaker": "Ryan",
        "qwen_language": "English",
    }
    with httpx.Client(timeout=1800.0) as client:
        resp = client.post(URL, json=payload)
        res = resp.json()["results"][0]
        print(
            f"n={n:2d} chars={len(text):4d} "
            f"path={res.get('pipeline_path')} "
            f"dur={res.get('duration_seconds')} "
            f"err={res.get('error')}"
        )