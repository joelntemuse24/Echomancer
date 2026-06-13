"""Tom Wolfe Ch. I audiobook — submits job and exits (no Modal log polling)."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from audiobook_client import submit_audiobook_job

PDF_PATH = Path(r"C:\Users\ntemu\Downloads\01_Chapter_I_Black_Shiny_FBI_Shoes.docx.pdf")
VOICE_PATH = Path(r"C:\Users\ntemu\Downloads\Ntw-enhanced-v2.wav")
OUT_MP3 = Path(r"C:\Users\ntemu\Downloads\hybrid_wolfe_chapter1.mp3")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wait", action="store_true", help="Poll R2 every 120s until ready")
    parser.add_argument("--timbre-mode", default="f5", choices=["qwen_clone", "f5"])
    args = parser.parse_args()

    return submit_audiobook_job(
        pdf_path=PDF_PATH,
        voice_path=VOICE_PATH,
        book_title="The Electric Kool-Aid Acid Test — Chapter I",
        out_mp3=OUT_MP3,
        timbre_mode=args.timbre_mode,
        job_prefix="hybrid-wolfe-ch1",
        wait=args.wait,
    )


if __name__ == "__main__":
    raise SystemExit(main())