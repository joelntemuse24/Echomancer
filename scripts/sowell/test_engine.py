"""Init-once and lock cleanup. The loader is a stub, not Kokoro."""

from __future__ import annotations

import sys
import threading
import unittest
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from engine import SAMPLE_RATE, SowellEngine


class ResidentRuntime(unittest.TestCase):
    def engine(self) -> SowellEngine:
        eng = SowellEngine()

        def load(pack, manifest) -> None:
            del pack, manifest
            eng._pipeline = object()
            eng._pack = object()
            eng.init_count += 1

        def render(text: str):
            return torch.zeros(SAMPLE_RATE), text, 0.01

        eng._load_locked = load
        eng._render_locked = render
        return eng

    def test_two_calls_initialize_once(self) -> None:
        eng = self.engine()
        pack = Path("unused")
        first, report1 = eng.speak("Hello.", pack)
        second, report2 = eng.speak("Hello again.", pack)
        self.assertGreater(len(first), 44)
        self.assertGreater(len(second), 44)
        self.assertEqual(eng.init_count, 1)
        self.assertTrue(report1["initializedThisCall"])
        self.assertFalse(report2["initializedThisCall"])

    def test_a_failed_render_releases_the_lock(self) -> None:
        eng = self.engine()

        def boom(text: str):
            del text
            raise RuntimeError("synth failed")

        eng._render_locked = boom
        with self.assertRaises(RuntimeError):
            eng.speak("Hello.", Path("unused"))
        eng._render_locked = lambda text: (torch.zeros(SAMPLE_RATE), text, 0.01)
        _wav, report = eng.speak("Hello.", Path("unused"))
        self.assertEqual(report["initCount"], 1)

    def test_overlapping_calls_on_one_engine_stay_serialized(self) -> None:
        eng = self.engine()
        inside = 0
        peak = 0
        real_render = eng._render_locked

        def render(text: str):
            nonlocal inside, peak
            inside += 1
            peak = max(peak, inside)
            try:
                return real_render(text)
            finally:
                inside -= 1

        eng._render_locked = render
        errors: list[BaseException] = []

        def run() -> None:
            try:
                eng.speak("Hello there.", Path("unused"))
            except BaseException as err:
                errors.append(err)

        threads = [threading.Thread(target=run) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        self.assertEqual(peak, 1)
        self.assertEqual(eng.init_count, 1)


if __name__ == "__main__":
    unittest.main()
