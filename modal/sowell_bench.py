"""Thread-count benchmark for the Kokoro CPU image. CPU only, no GPU.

The production app is `echomancer-sowell`. This is a second, deliberately
tiny app so a benchmark cannot change the live fleet: ``max_containers=1``,
``min_containers=0``, and a 10-second scaledown. It uses the same
``workers/sowell/Dockerfile`` image, so what it measures is what ships.

It reads no ``echomancer-sowell`` secret. The only mount is Drew's volume, and
that is optional: the benchmark speaks stock Kokoro (Walter's pack) unless a
`drew` voice is asked for and the volume happens to be there. A missing volume
reports `drew_unavailable` and renders the stock voice instead of failing.

Usage, one thread count per call:

    modal run modal/sowell_bench.py --threads 2
    modal run modal/sowell_bench.py --threads 4
    modal run modal/sowell_bench.py --threads 2 --threads 4 --repeats 3

Each case is a fresh container: `modal run` starts one, the render is measured
inside it once, and the container is left to scale down. To compare two counts
in one command, pass several ``--threads`` values; each becomes its own
function call.

What it prints, per case:

* ``wallSeconds``   — the render call, model already loaded
* ``audioSeconds``  — the WAV it produced, in seconds
* ``rtf``           — ``audioSeconds / wallSeconds`` (higher is faster)
* ``charsPerSecond``
* ``firstAudioSeconds`` and ``initSeconds`` so a cold container is visible

Cost: one CPU container for a few seconds. There is no GPU anywhere here.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import modal

APP_NAME = os.environ.get("SOWELL_BENCH_APP_NAME", "echomancer-sowell-bench")
_ROOT = Path(__file__).resolve().parents[1]
image = modal.Image.from_dockerfile(
    _ROOT / "workers" / "sowell" / "Dockerfile",
    context_dir=_ROOT,
)

DREW_VOLUME_NAME = os.environ.get("DREW_VOLUME_NAME", "andrew-distill")
DREW_VOLUME_MOUNT = os.environ.get("DREW_VOLUME_MOUNT", "/andrew-distill")

app = modal.App(APP_NAME)
PACK = os.environ.get("SOWELL_PACK", "/opt/sowell/voices/am_sowell_avg.pt")
MANIFEST = os.environ.get("SOWELL_MANIFEST", "/opt/sowell/voices/manifest.json")

drew_volume = modal.Volume.from_name(DREW_VOLUME_NAME, create_if_missing=True)

#: Three short texts. The first is the measured 719-character paragraph from
#: the voice runbook, so a result here is comparable with that table.
TEXTS = (
    (
        "harbor",
        (
            "The harbor was quiet after the rain. A gull stood on the wet stone "
            "and watched the boats. "
        )
        * 8,
    ),
    (
        "opening",
        "Chapter one. The lamps were lit along the quay, and nobody spoke.",
    ),
    (
        "prose",
        (
            "She counted the boats twice, because the first count had been in "
            "her head and the second on paper, and the two did not agree. "
        )
        * 3,
    ),
)


@app.cls(
    image=image,
    cpu=2,
    memory=6144,
    timeout=300,
    min_containers=0,
    max_containers=1,
    scaledown_window=10,
    volumes={DREW_VOLUME_MOUNT: drew_volume},
)
class Bench:
    """Load Kokoro once, measure each text, never serve production traffic."""

    @modal.enter()
    def load(self) -> None:
        sys.path.insert(0, "/opt/sowell/scripts")
        from engine import SowellEngine, apply_torch_threads

        # The container starts with whatever the image defaults to (2). Each
        # measured call re-applies the requested count before rendering.
        self.default_threads = apply_torch_threads()
        self.engine = SowellEngine()
        self.engine.load(Path(PACK), Path(MANIFEST))
        # Optional. A missing volume is reported, not fatal: the stock voice
        # still measures the image.
        self.drew = self.engine.load_drew()

    @modal.method()
    def measure(self, threads: int = 2, voice: str = "am_sowell", repeats: int = 1) -> dict:
        import torch

        sys.path.insert(0, "/opt/sowell/scripts")
        from engine import apply_torch_threads, torch_threads

        # Re-apply, so a pooled warm container does not answer with the
        # previous call's thread count.
        os.environ["SOWELL_TORCH_THREADS"] = str(max(1, int(threads)))
        applied = apply_torch_threads()
        rows: list[dict] = []
        for name, text in TEXTS:
            for repeat in range(max(1, int(repeats))):
                wav, report = self.engine.speak(
                    text,
                    Path(PACK),
                    Path(MANIFEST),
                    voice=voice,
                )
                wall = float(report["wallSeconds"]) or 0.0
                audio = float(report["seconds"])
                rows.append(
                    {
                        "text": name,
                        "repeat": repeat,
                        "chars": report["chars"],
                        "threads": applied,
                        "torchThreads": torch.get_num_threads(),
                        "wallSeconds": round(wall, 3),
                        "audioSeconds": round(audio, 3),
                        "rtf": round(audio / wall, 3) if wall > 0 else None,
                        "charsPerSecond": round(report["chars"] / wall, 1) if wall > 0 else None,
                        "firstAudioSeconds": report["firstAudioSeconds"],
                        "bytes": len(wav),
                        "initCount": report["initCount"],
                        "voice": report["voice"],
                    }
                )
        # The env default is not used for this call; report what ran.
        return {
            "threads": applied,
            "requested": int(threads),
            "envDefault": torch_threads(),
            "voice": voice,
            "drewLoaded": bool(self.drew) if voice == "drew" else None,
            "rows": rows,
        }


@app.local_entrypoint()
def main(
    threads: str = "2",
    voice: str = "am_sowell",
    repeats: int = 1,
) -> None:
    """Render the short texts at each thread count and print wall/audio/RTF.

    ``--threads 2 --threads 4`` (comma-separated also works) runs one call per
    count, each on a fresh container. CPU only.
    """
    import json

    counts = [int(part) for part in threads.replace(",", " ").split() if part.strip()]
    if not counts:
        counts = [2]
    bench = Bench()
    out = []
    for count in counts:
        result = bench.measure.remote(threads=count, voice=voice, repeats=repeats)
        out.append(result)
        print(json.dumps(result, indent=2), flush=True)
    # One summary line per case, easy to paste into a runbook.
    for result in out:
        for row in result["rows"]:
            print(
                f"threads={row['threads']} text={row['text']} "
                f"wall={row['wallSeconds']}s audio={row['audioSeconds']}s "
                f"rtf={row['rtf']}",
                flush=True,
            )
