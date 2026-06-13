"""Quick hybrid pipeline test with local PDF text + voice clip."""
from __future__ import annotations

import base64
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import httpx

PDF_PATH = Path(r"C:\Users\ntemu\Downloads\echo test 1.pdf")
VOICE_PATH = Path(r"C:\Users\ntemu\Downloads\Ntw-enhanced-v2.wav")
OUT_PATH = Path(r"C:\Users\ntemu\Downloads\hybrid_qwen_clone_test.wav")
HYBRID_URL = (
    "https://ntemusejoel--echomancer-hybrid-tts-fastapi-app.modal.run/generate_batch"
)


def extract_first_paragraph(pdf_path: Path) -> str:
    import fitz

    doc = fitz.open(pdf_path)
    text = re.sub(r"\s+", " ", "".join(page.get_text() for page in doc)).strip()
    doc.close()
    # Long excerpt — stresses MeanVC on realistic Qwen audio length
    return text[:1200]


def clip_voice(voice_path: Path, start: float = 0.0, duration: float = 15.0) -> bytes:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        out = tmp.name
    cmd = [
        "ffmpeg", "-y", "-i", str(voice_path),
        "-ss", "10", "-t", "30",
        "-ac", "1", "-ar", "48000", out,
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    data = Path(out).read_bytes()
    Path(out).unlink(missing_ok=True)
    return data


def main() -> int:
    hybrid_url = sys.argv[1] if len(sys.argv) > 1 else HYBRID_URL

    print(f"PDF: {PDF_PATH}")
    print(f"Voice: {VOICE_PATH}")
    print(f"Modal: {hybrid_url}")

    text = extract_first_paragraph(PDF_PATH)
    print(f"Test text ({len(text)} chars): {text[:120]}...")

    voice_bytes = clip_voice(VOICE_PATH)
    voice_b64 = base64.b64encode(voice_bytes).decode("utf-8")
    print(f"Voice clip: {len(voice_bytes)} bytes (15s @ 24kHz)")

    payload = {
        "texts": [text],
        "reference_audio_base64": voice_b64,
        "qwen_speaker": "Ryan",
        "qwen_language": "English",
        "instruct": (
            "You are narrating an audiobook. Read clearly and naturally. "
            "Use a calm, steady audiobook narrator pace."
        ),
    }

    print("Calling hybrid /generate_batch (cold start may take 2-5 min)...")
    with httpx.Client(timeout=1800.0, follow_redirects=True) as client:
        health_base = hybrid_url.replace("/generate_batch", "")
        health = client.get(f"{health_base}/health")
        print(f"Health: {health.status_code} {health.text[:200]}")

        resp = client.post(hybrid_url, json=payload)
        print(f"Status: {resp.status_code}")
        if resp.status_code != 200:
            print(resp.text[:2000])
            return 1

        data = resp.json()
        result = data["results"][0]
        if result.get("error"):
            print("Error:", result["error"])
            return 1

        audio = base64.b64decode(result["audio_base64"])
        OUT_PATH.write_bytes(audio)
        print(f"Saved: {OUT_PATH} ({len(audio)} bytes, {result.get('duration_seconds', '?')}s)")
        print("pipeline_mode:", data.get("pipeline_mode"))
        print("pipeline_path:", result.get("pipeline_path", "unknown"))
        if result.get("pipeline_path") == "f5_fallback":
            print("WARNING: F5 fallback was used — this is NOT Qwen voice clone output")
            return 2
        if result.get("pipeline_path") != "qwen_clone":
            print("WARNING: unexpected pipeline:", result.get("pipeline_path"))
            return 2
        return 0


if __name__ == "__main__":
    raise SystemExit(main())