"""A/B Wolfe opening: qwen_clone vs f5 on same paragraph."""
from __future__ import annotations

import base64
import re
import subprocess
import tempfile
from pathlib import Path

import fitz
import httpx

VOICE = Path(r"C:\Users\ntemu\Downloads\Ntw-enhanced-v2.wav")
PDF = Path(r"C:\Users\ntemu\Downloads\01_Chapter_I_Black_Shiny_FBI_Shoes.docx.pdf")
OUT_DIR = Path(r"C:\Users\ntemu\Downloads")
URL = "https://ntemusejoel--echomancer-hybrid-tts-fastapi-app.modal.run/generate_batch"


def wolfe_opening(chars: int = 1400) -> str:
    doc = fitz.open(PDF)
    text = re.sub(r"\s+", " ", "".join(page.get_text() for page in doc)).strip()
    doc.close()
    return text[:chars]


def clip_voice() -> str:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        out = tmp.name
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(VOICE), "-ss", "10", "-t", "30", "-ac", "1", "-ar", "48000", out],
        check=True,
        capture_output=True,
    )
    b64 = base64.b64encode(Path(out).read_bytes()).decode()
    Path(out).unlink(missing_ok=True)
    return b64


def main() -> int:
    text = wolfe_opening()
    voice_b64 = clip_voice()
    print(f"Text: {len(text)} chars")
    print(text[:120], "...")

    for mode in ("qwen_clone", "f5"):
        payload = {
            "texts": [text],
            "reference_audio_base64": voice_b64,
            "qwen_language": "English",
            "timbre_mode": mode,
        }
        print(f"\nGenerating {mode} (may take a few min)...")
        with httpx.Client(timeout=1800.0, follow_redirects=True) as client:
            resp = client.post(URL, json=payload)
            resp.raise_for_status()
            res = resp.json()["results"][0]
        if res.get("error"):
            print(f"  FAILED: {res['error']}")
            continue
        dest = OUT_DIR / f"wolfe_ab_{mode}.wav"
        dest.write_bytes(base64.b64decode(res["audio_base64"]))
        print(f"  -> {dest} ({res.get('duration_seconds', '?')}s) path={res.get('pipeline_path')}")

    print("\nCompare wolfe_ab_qwen_clone.wav vs wolfe_ab_f5.wav")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())