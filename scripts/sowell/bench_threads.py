"""Compare Torch thread counts and two CPU pairs. Real Kokoro, not a mock.

Each case is a fresh process so the thread pool is not already started.
Prints one JSON object per case.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

PACK = sys.argv[1] if len(sys.argv) > 1 else "/tmp/sowell/am_sowell_avg.pt"
ROOT = Path(__file__).resolve().parents[2]
PARAGRAPH = (
    "The harbor was quiet after the rain. A gull stood on the wet stone and watched the boats. "
    * 8
).strip()
CHILD = r"""
import json, os, sys
from pathlib import Path
sys.path.insert(0, "scripts/sowell")
os.environ["SOWELL_CPU_THREADS"] = os.environ["SOWELL_THREADS"]
from engine import SowellEngine
pack = Path(os.environ["PACK"])
text = os.environ["TEXT"]
eng = SowellEngine()
cold_wav, cold = eng.speak(text, pack)
warm_wav, warm = eng.speak(text, pack)
print(json.dumps({
    "threads": eng._threads,
    "chars": warm["chars"],
    "audioSeconds": warm["seconds"],
    "spokenWords": warm["spokenWords"],
    "coldWall": cold["wallSeconds"],
    "coldFirst": cold["firstAudioSeconds"],
    "warmWall": warm["wallSeconds"],
    "warmFirst": warm["firstAudioSeconds"],
    "initCount": eng.init_count,
    "sameBytes": len(cold_wav) == len(warm_wav),
}))
"""


def run(label: str, threads: str, cores: str | None) -> dict:
    env = os.environ.copy()
    env["SOWELL_THREADS"] = threads
    env["PACK"] = PACK
    env["TEXT"] = PARAGRAPH
    env["OMP_NUM_THREADS"] = threads
    env["OPENBLAS_NUM_THREADS"] = threads
    env["MKL_NUM_THREADS"] = threads
    cmd = ["python3", "-c", CHILD]
    if cores:
        cmd = ["taskset", "-c", cores, *cmd]
    proc = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True)
    line = [row for row in proc.stdout.splitlines() if row.startswith("{")]
    if proc.returncode != 0 or not line:
        return {"label": label, "error": (proc.stderr or proc.stdout)[-500:]}
    body = json.loads(line[-1])
    body["label"] = label
    return body


def main() -> int:
    cases = [
        run("2cpu-1thread", "1", "0,1"),
        run("2cpu-2thread", "2", "0,1"),
        run("2cpu-4thread", "4", "0,1"),
        run("4cpu-4thread", "4", None),
    ]
    print(json.dumps(cases, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
