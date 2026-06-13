"""Last Bone Phase A — Chatterbox Turbo Wolfe opening (per-chunk requests).

DISABLED by default to avoid Modal credit burn. Pass --confirm to run.
"""
from __future__ import annotations

import argparse
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
OUT = Path(r"C:\Users\ntemu\Downloads\last_bone_chatterbox_wolfe.wav")
BASE = "https://ntemusejoel--echomancer-chatterbox-tts-fastapi-app.modal.run"
MAX_CHARS = 450
TARGET_CHARS = 3800
EXAGGERATION = 0.55


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


def wolfe_chunks() -> list[str]:
    doc = fitz.open(PDF)
    text = re.sub(r"\s+", " ", "".join(page.get_text() for page in doc)).strip()
    doc.close()
    return split_text_into_paragraphs(text[:TARGET_CHARS], max_chars=MAX_CHARS)


def concat_wavs(paths: list[Path], dest: Path, silence_s: float = 0.25) -> None:
    lines = []
    for i, p in enumerate(paths):
        lines.append(f"file '{p.as_posix()}'")
        if i < len(paths) - 1:
            sil = Path(tempfile.mkdtemp()) / f"sil_{i}.wav"
            subprocess.run(
                [
                    "ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
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
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="Required: acknowledge Modal GPU spend before running",
    )
    args = parser.parse_args()
    if not args.confirm:
        print("BLOCKED: last_bone Phase A is disabled by default (Modal credit guard).")
        print("Chatterbox app is STOPPED. Re-enable only after HF_TOKEN is in Modal.")
        print("To run anyway: python scripts/last_bone_phase_a.py --confirm")
        return 2

    chunks = wolfe_chunks()
    voice_b64 = clip_voice()
    print(f"Phase A: Chatterbox Turbo — {len(chunks)} chunks, exaggeration={EXAGGERATION}")

    tmp_dir = Path(tempfile.mkdtemp(prefix="last_bone_chatterbox_"))
    wav_paths: list[Path] = []
    total_dur = 0.0

    with httpx.Client(timeout=1800.0, follow_redirects=True) as client:
        health = client.get(f"{BASE}/health")
        print(f"Health: {health.status_code}")
        print("Warming Chatterbox model (first load ~2-5 min)...", flush=True)
        warm = client.post(f"{BASE}/warmup")
        print(f"Warmup: {warm.status_code} {warm.text[:200]}", flush=True)
        if warm.status_code != 200:
            warm.raise_for_status()

        for i, text in enumerate(chunks):
            print(f"  chunk {i+1}/{len(chunks)} ({len(text)} chars)...", flush=True)
            resp = client.post(
                f"{BASE}/generate_single",
                json={
                    "text": text,
                    "reference_audio_base64": voice_b64,
                    "exaggeration": EXAGGERATION,
                },
            )
            if resp.status_code != 200:
                print(resp.text[:2000])
                resp.raise_for_status()
            res = resp.json()
            p = tmp_dir / f"chunk_{i:03d}.wav"
            p.write_bytes(base64.b64decode(res["audio_base64"]))
            wav_paths.append(p)
            total_dur += float(res.get("duration_seconds") or 0)
            print(f"    done ({res.get('duration_seconds', '?')}s)")

    concat_wavs(wav_paths, OUT)
    print(f"Saved: {OUT} (~{total_dur:.0f}s speech)")
    print("Compare vs wolfe_f5_longform_test.wav and wolfe_ab_qwen_clone.wav")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())