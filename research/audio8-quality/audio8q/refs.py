"""Reference voices for the harness.

Two LibriSpeech dev-clean speakers are used so every metric is reported twice:
a fix that only works on one timbre is not a fix. They are CC-BY 4.0
(openslr.org/12) and are committed as 44.1 kHz mono wavs so the Modal jobs and
the CPU harness need no network.

`refs.json` holds the exact transcript of each clip. Audio8 conditions on the
reference audio *and* its transcript, so a mismatched transcript silently
degrades cloning; that is why the text lives next to the wav rather than being
re-derived at run time.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

REF_DIR = Path(__file__).resolve().parent.parent / "refs"


def load(refs_file: str | Path | None = None) -> dict[str, dict]:
    """{name: {wav, text, speaker, seconds}}."""
    path = Path(refs_file) if refs_file else REF_DIR / "refs.json"
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def path_of(name: str) -> str:
    entry = load()[name]
    return str((REF_DIR / entry["wav"]).resolve())


def names() -> list[str]:
    return sorted(load())


def validate() -> list[str]:
    """Every wav exists, is mono 44.1 kHz, and has a non-empty transcript."""
    problems: list[str] = []
    import soundfile as sf

    for name in names():
        entry = load()[name]
        wav = REF_DIR / entry["wav"]
        if not wav.exists():
            problems.append(f"{name}: missing {wav}")
            continue
        info = sf.info(str(wav))
        if info.samplerate != 44100 or info.channels != 1:
            problems.append(f"{name}: expected mono 44.1 kHz, got {info.channels}ch {info.samplerate} Hz")
        if not entry.get("text"):
            problems.append(f"{name}: empty transcript")
    return problems


if __name__ == "__main__":
    issues = validate()
    print("\n".join(issues) if issues else f"ok: {len(names())} references")
    raise SystemExit(1 if issues else 0)
