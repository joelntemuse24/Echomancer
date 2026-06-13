"""F5 long-form stress test: Wolfe opening split into ~480-char micro-chunks."""
from __future__ import annotations

import base64
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import fitz
import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "modal"))
from tts_shared import split_text_into_paragraphs

VOICE = Path(r"C:\Users\ntemu\Downloads\Ntw-enhanced-v2.wav")
PDF = Path(r"C:\Users\ntemu\Downloads\01_Chapter_I_Black_Shiny_FBI_Shoes.docx.pdf")
OUT = Path(r"C:\Users\ntemu\Downloads\wolfe_f5_longform_test.wav")
URL = "https://ntemusejoel--echomancer-hybrid-tts-fastapi-app.modal.run/generate_batch"
F5_MAX_CHARS = 480
TARGET_CHARS = 3800


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


def wolfe_chunks() -> list[str]:
    doc = fitz.open(PDF)
    text = re.sub(r"\s+", " ", "".join(page.get_text() for page in doc)).strip()
    doc.close()
    text = text[:TARGET_CHARS]
    return split_text_into_paragraphs(text, max_chars=F5_MAX_CHARS)


def concat_wavs(paths: list[Path], dest: Path, silence_s: float = 0.28) -> None:
    lines = []
    for i, p in enumerate(paths):
        lines.append(f"file '{p.as_posix()}'")
        if i < len(paths) - 1:
            sil = Path(tempfile.mkdtemp()) / f"sil_{i}.wav"
            subprocess.run(
                [
                    "ffmpeg", "-y", "-f", "lavfi", "-i", f"anullsrc=r=24000:cl=mono",
                    "-t", str(silence_s), str(sil),
                ],
                check=True,
                capture_output=True,
            )
            lines.append(f"file '{sil.as_posix()}'")
    list_file = dest.with_suffix(".txt")
    list_file.write_text("\n".join(lines), encoding="utf-8")
    subprocess.run(
        ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file), "-c", "copy", str(dest)],
        check=True,
        capture_output=True,
    )
    list_file.unlink(missing_ok=True)


def main() -> int:
    chunks = wolfe_chunks()
    voice_b64 = clip_voice()
    print(f"Chunks: {len(chunks)} (max {F5_MAX_CHARS} chars each, ~{TARGET_CHARS} total)")
    for i, c in enumerate(chunks[:3]):
        print(f"  [{i}] {len(c)} chars: {c[:80]}...")

    payload = {
        "texts": chunks,
        "reference_audio_base64": voice_b64,
        "qwen_language": "English",
        "timbre_mode": "f5",
    }
    print("Generating F5 micro-chunks (cold start may take several min)...")
    with httpx.Client(timeout=3600.0, follow_redirects=True) as client:
        resp = client.post(URL, json=payload)
        resp.raise_for_status()
        data = resp.json()

    tmp_dir = Path(tempfile.mkdtemp(prefix="wolfe_f5_chunks_"))
    wav_paths: list[Path] = []
    total_dur = 0.0
    for i, res in enumerate(data["results"]):
        if res.get("error"):
            print(f"Chunk {i} FAILED: {res['error']}")
            return 1
        p = tmp_dir / f"chunk_{i:03d}.wav"
        p.write_bytes(base64.b64decode(res["audio_base64"]))
        wav_paths.append(p)
        total_dur += float(res.get("duration_seconds") or 0)
        print(f"  chunk {i}: {res.get('duration_seconds', '?')}s path={res.get('pipeline_path')}")

    concat_wavs(wav_paths, OUT)
    print(f"Saved: {OUT} ({OUT.stat().st_size} bytes, ~{total_dur:.0f}s speech)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())