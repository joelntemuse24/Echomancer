"""Call hybrid /generate_batch and surface MeanVC vs F5 path."""
from __future__ import annotations

import base64
import json
import subprocess
import tempfile
from pathlib import Path

import httpx

VOICE = Path(r"C:\Users\ntemu\Downloads\Ntw-enhanced-v2.wav")
URL = "https://ntemusejoel--echomancer-hybrid-tts-fastapi-app.modal.run/generate_batch"

text = (
    "Imagine that the natural sciences were to suffer the effects of a catastrophe. "
    "A series of environmental disasters are blamed by the general public on the scientists."
)

with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
    out = tmp.name
subprocess.run(
    ["ffmpeg", "-y", "-i", str(VOICE), "-ss", "0", "-t", "15", "-ac", "1", "-ar", "24000", out],
    check=True,
    capture_output=True,
)
voice_b64 = base64.b64encode(Path(out).read_bytes()).decode()
Path(out).unlink(missing_ok=True)

payload = {
    "texts": [text],
    "reference_audio_base64": voice_b64,
    "qwen_speaker": "Ryan",
    "qwen_language": "English",
}

with httpx.Client(timeout=1800.0) as client:
    resp = client.post(URL, json=payload)
    print("HTTP", resp.status_code)
    if resp.status_code != 200:
        print(resp.text[:2000])
        raise SystemExit(1)
    data = resp.json()
    res = data["results"][0]
    meta = {k: v for k, v in res.items() if k != "audio_base64"}
    print(json.dumps(meta, indent=2))
    if meta.get("meanvc_error"):
        print("MEANVC_ERROR:", meta["meanvc_error"])
    if res.get("pipeline_path") == "f5_fallback":
        raise SystemExit(2)