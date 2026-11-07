"""Real CPU timings for one resident engine and two engines side by side.

This loads Kokoro. It is not a mock. It does not call Modal.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from engine import SowellEngine

PACK = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/sowell/am_sowell_avg.pt")
SHORT = "The harbor was quiet after the rain."
LONG = (
    "The harbor was quiet after the rain. A gull stood on the wet stone and watched the boats. "
    * 12
).strip()


def once(engine: SowellEngine, text: str) -> dict:
    started = time.perf_counter()
    wav, report = engine.speak(text, PACK)
    return {
        **report,
        "requestSeconds": round(time.perf_counter() - started, 3),
        "wavBytes": len(wav),
    }


def main() -> int:
    engine = SowellEngine()
    cold = once(engine, SHORT)
    warm = once(engine, SHORT)
    warm_again = once(engine, SHORT)
    long = once(engine, LONG)
    left = SowellEngine()
    right = SowellEngine()
    parallel: dict[str, dict] = {}
    errors: list[str] = []

    def run(name: str, eng: SowellEngine) -> None:
        try:
            parallel[name] = once(eng, SHORT)
        except Exception as err:
            errors.append(f"{name}: {err}")

    started = time.perf_counter()
    threads = [
        threading.Thread(target=run, args=("a", left)),
        threading.Thread(target=run, args=("b", right)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    parallel_wall = round(time.perf_counter() - started, 3)
    print(
        json.dumps(
            {
                "cold": cold,
                "warm": warm,
                "warmAgain": warm_again,
                "long": long,
                "parallel": parallel,
                "parallelWallSeconds": parallel_wall,
                "sameWav": cold["wavBytes"] == warm["wavBytes"],
                "errors": errors,
                "singleEngineInitCount": engine.init_count,
            }
        )
    )
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
