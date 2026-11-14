"""Init-once, lock cleanup, and Drew's single speed multiply.

The loaders are stubs, not Kokoro. Torch is real when it is installed, because
`_wav_bytes` does `torch.clamp`; the suite is skipped only when torch itself is
missing (a bare CI runner), which is how the other packs suites behave.
"""

from __future__ import annotations

import sys
import threading
import unittest
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import engine as engine_module  # noqa: E402
from engine import SAMPLE_RATE, SowellEngine  # noqa: E402


class ResidentRuntime(unittest.TestCase):
    def engine(self) -> SowellEngine:
        eng = SowellEngine()

        def load(pack, manifest) -> None:
            del pack, manifest
            eng._pipelines = {"a": object(), "b": object()}
            eng._packs = {"am_sowell": torch.zeros(1), "bm_george": torch.zeros(1)}
            eng.init_count += 1

        def render(text: str, voice: str = "am_sowell", speed: float = 1.0):
            del voice, speed
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

        def boom(text: str, voice: str = "am_sowell", speed: float = 1.0):
            del text, voice, speed
            raise RuntimeError("synth failed")

        eng._render_locked = boom
        with self.assertRaises(RuntimeError):
            eng.speak("Hello.", Path("unused"))
        eng._render_locked = lambda text, voice="am_sowell", speed=1.0: (
            torch.zeros(SAMPLE_RATE),
            text,
            0.01,
        )
        _wav, report = eng.speak("Hello.", Path("unused"))
        self.assertEqual(report["initCount"], 1)

    def test_overlapping_calls_on_one_engine_stay_serialized(self) -> None:
        eng = self.engine()
        inside = 0
        peak = 0
        real_render = eng._render_locked

        def render(text: str, voice: str = "am_sowell", speed: float = 1.0):
            nonlocal inside, peak
            inside += 1
            peak = max(peak, inside)
            try:
                return real_render(text, voice, speed)
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


class DrewSpeedMultiply(unittest.TestCase):
    """0.88 is applied once, in `_render_locked`, and only for Drew."""

    def setUp(self) -> None:
        self._real_kpipeline = getattr(engine_module, "KPipeline", None)
        self._real_runs = engine_module.iter_phoneme_runs
        self.addCleanup(
            lambda: setattr(engine_module, "KPipeline", self._real_kpipeline)
            if self._real_kpipeline is not None
            else delattr(engine_module, "KPipeline")
        )
        self.addCleanup(setattr, engine_module, "iter_phoneme_runs", self._real_runs)

    def engine(self) -> tuple[SowellEngine, list[float]]:
        eng = SowellEngine()
        seen: list[float] = []

        class FakePipeline:
            model = object()

            def g2p(self, text: str):
                return None, [text]

        class FakeKPipeline:
            @staticmethod
            def infer(model, phonemes, pack, speed):
                del model, pack, phonemes
                seen.append(speed)
                return type("Out", (), {"audio": torch.zeros(SAMPLE_RATE)})()

        def fake_runs(pipeline, tokens):
            del pipeline, tokens
            yield "Hello.", "hɛˈloʊ"

        eng._drew_pipes = {"a": FakePipeline()}
        eng._drew_pack = torch.zeros(1)
        eng._pipelines = {"a": FakePipeline(), "b": FakePipeline()}
        eng._packs = {
            "am_sowell": torch.zeros(1),
            "bm_george": torch.zeros(1),
        }
        engine_module.KPipeline = FakeKPipeline
        engine_module.iter_phoneme_runs = fake_runs
        return eng, seen

    def test_drew_renders_at_point_eight_eight_for_app_speed_one(self) -> None:
        eng, seen = self.engine()
        _wav, report = eng.speak("Hello.", Path("unused"), voice="drew", speed=1.0)
        self.assertEqual(seen, [0.88])
        self.assertEqual(report["voice"], "drew")
        self.assertEqual(report["speed"], 0.88)

    def test_scales_from_native_and_never_double_applies(self) -> None:
        eng, seen = self.engine()
        eng.speak("Hello.", Path("unused"), voice="drew", speed=0.95)
        eng.speak("Hello.", Path("unused"), voice="drew", speed=0.95)
        self.assertEqual(seen, [0.836, 0.836])

    def test_walter_and_george_stay_at_one(self) -> None:
        eng, seen = self.engine()
        eng.speak("Hello.", Path("unused"), voice="sowell", speed=0.9)
        eng.speak("Hello.", Path("unused"), voice="george", speed=0.9)
        self.assertEqual(seen, [1.0, 1.0])


if __name__ == "__main__":
    unittest.main()
