"""Generate same text in qwen_clone vs f5 for A/B timbre comparison."""
from __future__ import annotations

import base64
import json
import subprocess
import tempfile
from pathlib import Path

import httpx

VOICE = Path(r"C:\Users\ntemu\Downloads\Ntw-enhanced-v2.wav")
OUT_DIR = Path(r"C:\Users\ntemu\Downloads")
URL = "https://ntemusejoel--echomancer-hybrid-tts-fastapi-app.modal.run/generate_batch"

text = (
    "Imagine that the natural sciences were to suffer the effects of a catastrophe. "
    "A series of environmental disasters are blamed by the general public on the scientists."
)

with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
    out = tmp.name
subprocess.run(
    ["ffmpeg", "-y", "-i", str(VOICE), "-ss", "10", "-t", "30", "-ac", "1", "-ar", "48000", out],
    check=True,
    capture_output=True,
)
voice_b64 = base64.b64encode(Path(out).read_bytes()).decode()
Path(out).unlink(missing_ok=True)

for mode in ("qwen_clone", "f5"):
    payload = {
        "texts": [text],
        "reference_audio_base64": voice_b64,
        "qwen_language": "English",
        "timbre_mode": mode,
    }
    print(f"Requesting {mode}...")
    with httpx.Client(timeout=1800.0, follow_redirects=True) as client:
        resp = client.post(URL, json=payload)
        resp.raise_for_status()
        res = resp.json()["results"][0]
    if res.get("error"):
        print(mode, "FAILED:", res["error"])
        continue
    dest = OUT_DIR / f"timbre_compare_{mode}.wav"
    dest.write_bytes(base64.b64decode(res["audio_base64"]))
    print(f"  -> {dest} ({res.get('duration_seconds')}s) path={res.get('pipeline_path')}")

print("Done. Compare timbre_compare_qwen_clone.wav vs timbre_compare_f5.wav")