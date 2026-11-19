"""Offline A/B of Drew prosody G on the production render path.

Style row 300, Kokoro speed 0.88, and the production phoneme chunker.
No Modal call. The private weights are not in git. Point
``DREW_VOLUME_MOUNT`` at the directory that contains

    kokoro/retrain_v3/stageA/step00900_kmodel.pth
    kokoro/retrain_v3/stageA/step00900_voice.pt

then:

    python3 scripts/sowell/prosody_ab.py \\
        scripts/sowell/fixtures/drew_prosody_passage.json \\
        /tmp/drew-prosody-ab

Writes ``off.wav`` / ``on.wav`` and a json sidecar each. Three timed
renders follow one warmup, flag forced off and then forced on, on the
same loaded engine. Exit 2 when the weights or Kokoro are absent.
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

INSTRUCTIONS = """
Render on a machine that has the Drew volume and Kokoro 0.9.4:

  DREW_VOLUME_MOUNT=/andrew-distill \\
  python3 scripts/sowell/prosody_ab.py \\
      scripts/sowell/fixtures/drew_prosody_passage.json \\
      /tmp/drew-prosody-ab

The engine pins style row 300 and multiplies speed 1.0 by 0.88.
Do not set a row. Do not deploy. Then:

  python3 scripts/sowell/prosody_metrics.py \\
      /tmp/drew-prosody-ab/off.wav /tmp/drew-prosody-ab/on.wav
""".strip()


def _passage(path: Path) -> str:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, list):
        return "\n\n".join(str(part) for part in data)
    raise SystemExit(f"{path} is not a list of paragraphs")


def _sentence_seconds(engine, text: str, chunk_seconds: list[float]) -> list[dict] | None:
    from engine import iter_phoneme_runs
    from prosody_rules import plan_chunks

    pipeline = (engine._drew_pipes or {}).get("a")
    if pipeline is None:
        return None
    cleaned = " ".join(text.split())
    _ps, tokens = pipeline.g2p(cleaned)
    runs = [(graphemes, phonemes) for graphemes, phonemes in iter_phoneme_runs(pipeline, tokens) if phonemes]
    if len(runs) != len(chunk_seconds):
        return None
    plans = plan_chunks(runs)
    sentences: list[dict] = []
    current: dict | None = None
    for chunk_index, spans in enumerate(plans):
        chunk_s = float(chunk_seconds[chunk_index])
        span_chars = sum(span.end - span.start for span in spans) or 1
        for span in spans:
            share = chunk_s * (span.end - span.start) / span_chars
            if current is None or span.sent_offset == 0:
                current = {"kind": span.kind, "seconds": 0.0}
                sentences.append(current)
            current["seconds"] = round(float(current["seconds"]) + share, 4)
            current["kind"] = span.kind
    return sentences


def _once(engine, text: str, prosody: str) -> tuple[bytes, dict]:
    started = time.perf_counter()
    wav, report = engine.speak(text, Path("unused"), voice="drew", speed=1.0, prosody=prosody)
    report = dict(report)
    report["measuredWallSeconds"] = round(time.perf_counter() - started, 3)
    return wav, report


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(INSTRUCTIONS)
        return 2
    passage = Path(argv[1])
    out = Path(argv[2])
    try:
        from drew import drew_assets_present, drew_kmodel_path, drew_voice_pack_path
        from engine import SowellEngine, apply_torch_threads
    except ImportError as err:
        print(f"cannot render: {err}")
        print(INSTRUCTIONS)
        return 2
    if not drew_assets_present():
        print("Drew weights are not on this machine.")
        print(f"looked for {drew_kmodel_path()}")
        print(f"looked for {drew_voice_pack_path()}")
        print(INSTRUCTIONS)
        return 2
    text = _passage(passage)
    threads = apply_torch_threads()
    engine = SowellEngine()
    print(f"threads={threads} warmup", flush=True)
    _once(engine, "The harbor was quiet.", "")
    out.mkdir(parents=True, exist_ok=True)
    for label, prosody in (("off", ""), ("on", "G")):
        runs = []
        wav = b""
        report: dict = {}
        for index in range(3):
            wav, report = _once(engine, text, prosody)
            infer = round(float(report["wallSeconds"]) - float(report["loadSeconds"]), 3)
            runs.append(
                {
                    "wallSeconds": report["wallSeconds"],
                    "loadSeconds": report["loadSeconds"],
                    "inferSeconds": infer,
                    "firstAudioSeconds": report["firstAudioSeconds"],
                    "sha256": hashlib.sha256(wav).hexdigest(),
                }
            )
            print(f"{label} run {index + 1} infer={infer}s first={report['firstAudioSeconds']}s", flush=True)
        sentences = _sentence_seconds(engine, text, list(report.get("chunkSeconds") or []))
        sidecar = {
            "prosody": report.get("prosody"),
            "styleIndex": report.get("styleIndex"),
            "speed": report.get("speed"),
            "seconds": report.get("seconds"),
            "chunkSeconds": report.get("chunkSeconds"),
            "sentences": sentences,
            "runs": runs,
        }
        (out / f"{label}.wav").write_bytes(wav)
        (out / f"{label}.json").write_text(json.dumps(sidecar, indent=1) + "\n", encoding="utf-8")
        hashes = [row["sha256"] for row in runs]
        print(
            json.dumps(
                {
                    "file": label,
                    **{k: sidecar[k] for k in ("prosody", "styleIndex", "speed", "seconds")},
                    "repeatable": len(set(hashes)) == 1,
                    "inferSeconds": [row["inferSeconds"] for row in runs],
                }
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
