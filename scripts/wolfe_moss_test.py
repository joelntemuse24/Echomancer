"""Wolfe opening — MOSS-TTS-v1.5 only (no F5)."""
from __future__ import annotations

import base64
import re
import subprocess
import tempfile
import time
from pathlib import Path

import fitz
import httpx

VOICE = Path(r"C:\Users\ntemu\Downloads\Ntw-enhanced-v2.wav")
PDF = Path(r"C:\Users\ntemu\Downloads\01_Chapter_I_Black_Shiny_FBI_Shoes.docx.pdf")
OUT = Path(r"C:\Users\ntemu\Downloads\wolfe_moss_v15.wav")
MOSS_URL = "https://ntemusejoel--echomancer-moss-tts-fastapi-app.modal.run/generate_batch"


def wolfe_opening(chars: int = 600) -> str:
    doc = fitz.open(PDF)
    text = re.sub(r"\s+", " ", "".join(page.get_text() for page in doc)).strip()
    doc.close()
    return text[:chars]


def clip_voice() -> str:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        out = tmp.name
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(VOICE), "-ss", "10", "-t", "30", "-ac", "1", "-ar", "24000", out],
        check=True,
        capture_output=True,
    )
    b64 = base64.b64encode(Path(out).read_bytes()).decode()
    Path(out).unlink(missing_ok=True)
    return b64


def main() -> int:
    text = wolfe_opening()
    voice_b64 = clip_voice()
    print(f"MOSS Wolfe test: {len(text)} chars")
    print(text[:120], "...")
    print("Cold start + 8B inference may take 3-8 min on first run...")

    start = time.time()
    with httpx.Client(timeout=1800.0, follow_redirects=True) as client:
        resp = client.post(
            MOSS_URL,
            json={
                "texts": [text],
                "reference_audio_base64": voice_b64,
                "moss_language": "English",
            },
        )
        resp.raise_for_status()
        body = resp.json()

    res = body["results"][0]
    if res.get("error"):
        print(f"FAILED: {res['error']}")
        return 1

    OUT.write_bytes(base64.b64decode(res["audio_base64"]))
    print(f"OK in {time.time() - start:.0f}s -> {OUT}")
    print(f"Audio duration: {res.get('duration_seconds', '?')}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())