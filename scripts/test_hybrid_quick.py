"""Minimal hybrid test — one short sentence, 30 min timeout."""
import base64
import subprocess
import tempfile
from pathlib import Path

import httpx

VOICE = Path(r"C:\Users\ntemu\Downloads\Ntw-enhanced-v2.wav")
OUT = Path(r"C:\Users\ntemu\Downloads\hybrid_qwen_tuned_test.wav")
URL = "https://ntemusejoel--echomancer-hybrid-tts-fastapi-app.modal.run/generate_batch"

text = (
    "Imagine that the natural sciences were to suffer the effects of a catastrophe. "
    "A series of environmental disasters are blamed by the general public on the scientists."
)

with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
    out = tmp.name
subprocess.run(
    ["ffmpeg", "-y", "-i", str(VOICE), "-ss", "10", "-t", "30", "-ac", "1", "-ar", "48000", out],
    check=True, capture_output=True,
)
voice_b64 = base64.b64encode(Path(out).read_bytes()).decode()
Path(out).unlink(missing_ok=True)

payload = {
    "texts": [text],
    "reference_audio_base64": voice_b64,
    "qwen_speaker": "Ryan",
    "qwen_language": "English",
}

print("Sending request (models may cold-start 10-20 min)...")
with httpx.Client(timeout=1800.0, follow_redirects=True) as c:
    resp = c.post(URL, json=payload)
    print("status", resp.status_code)
    data = resp.json()
    r = data["results"][0]
    if r.get("error"):
        print("ERROR:", r["error"])
    else:
        OUT.write_bytes(__import__("base64").b64decode(r["audio_base64"]))
        path = r.get("pipeline_path", "unknown")
        print(f"OK -> {OUT} ({r.get('duration_seconds')}s) pipeline={path}")
        if path == "f5_fallback":
            print("WARNING: F5 fallback — NOT Qwen voice clone")
            raise SystemExit(2)
        if path not in ("qwen_clone", "f5", "f5_fallback"):
            print(f"WARNING: unexpected pipeline={path}")
            raise SystemExit(2)