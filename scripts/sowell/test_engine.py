"""Init-once, lock cleanup, and Drew's single speed multiply.

The loaders are stubs, not Kokoro. Torch is real when it is installed, because
`_wav_bytes` does `torch.clamp`; the suite is skipped only when torch itself is
missing (a bare CI runner), which is how the other packs suites behave.
"""

from __future__ import annotations

import os
import sys
import threading
import unittest
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import engine as engine_module  # noqa: E402
from drew import DREW_FIXED_STYLE_INDEX  # noqa: E402
from engine import SAMPLE_RATE, SowellEngine  # noqa: E402
from pack import SOWELL_FIXED_STYLE_INDEX  # noqa: E402
from style import fixed_style_index, pin_style  # noqa: E402


class ResidentRuntime(unittest.TestCase):
    def engine(self) -> SowellEngine:
        eng = SowellEngine()

        def load(pack, manifest) -> None:
            del pack, manifest
            eng._pipelines = {"a": object(), "b": object()}
            eng._packs = {"am_sowell": torch.zeros(1), "bm_george": torch.zeros(1)}
            eng.init_count += 1

        def render(text: str, voice: str = "am_sowell", speed: float = 1.0, prosody: str | None = None):
            del voice, speed, prosody
            return torch.zeros(SAMPLE_RATE), text, 0.01, [1.0], None

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

        def boom(text: str, voice: str = "am_sowell", speed: float = 1.0, prosody: str | None = None):
            del text, voice, speed, prosody
            raise RuntimeError("synth failed")

        eng._render_locked = boom
        with self.assertRaises(RuntimeError):
            eng.speak("Hello.", Path("unused"))
        eng._render_locked = lambda text, voice="am_sowell", speed=1.0, prosody=None: (
            torch.zeros(SAMPLE_RATE),
            text,
            0.01,
            [1.0],
            None,
        )
        _wav, report = eng.speak("Hello.", Path("unused"))
        self.assertEqual(report["initCount"], 1)

    def test_overlapping_calls_on_one_engine_stay_serialized(self) -> None:
        eng = self.engine()
        inside = 0
        peak = 0
        real_render = eng._render_locked

        def render(text: str, voice: str = "am_sowell", speed: float = 1.0, prosody: str | None = None):
            nonlocal inside, peak
            inside += 1
            peak = max(peak, inside)
            try:
                return real_render(text, voice, speed, prosody)
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
    """1.0 is applied once, in `_render_locked`, and only for Drew."""

    def setUp(self) -> None:
        # These stubs have no predictor. A leaked flag would wrap the stock
        # forward and the speed check would no longer be the stock call.
        self._prosody = os.environ.pop("DREW_PROSODY_RULES", None)
        self.addCleanup(
            lambda: os.environ.__setitem__("DREW_PROSODY_RULES", self._prosody)
            if self._prosody is not None
            else os.environ.pop("DREW_PROSODY_RULES", None)
        )
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

    def test_drew_renders_at_one_for_app_speed_one(self) -> None:
        eng, seen = self.engine()
        _wav, report = eng.speak("Hello.", Path("unused"), voice="drew", speed=1.0)
        self.assertEqual(seen, [1.0])
        self.assertEqual(report["voice"], "drew")
        self.assertEqual(report["speed"], 1.0)

    def test_scales_from_native_and_never_double_applies(self) -> None:
        eng, seen = self.engine()
        eng.speak("Hello.", Path("unused"), voice="drew", speed=0.95)
        eng.speak("Hello.", Path("unused"), voice="drew", speed=0.95)
        self.assertEqual(seen, [0.95, 0.95])

    def test_walter_and_george_stay_at_one(self) -> None:
        eng, seen = self.engine()
        _wav, walter = eng.speak("Hello.", Path("unused"), voice="sowell", speed=0.9)
        _wav, george = eng.speak("Hello.", Path("unused"), voice="george", speed=0.9)
        self.assertEqual(seen, [1.0, 1.0])
        self.assertEqual(walter["speed"], 1.0)
        self.assertEqual(george["speed"], 1.0)
        self.assertIsNone(walter["styleIndex"])
        self.assertIsNone(george["styleIndex"])

    def test_a_failed_drew_load_is_retried(self) -> None:
        eng = SowellEngine()
        eng._drew_error = "frozen from a snapshot"
        calls = {"n": 0}
        saved = {
            "check_drew_assets": engine_module.check_drew_assets,
            "load_kmodel": engine_module.load_kmodel,
            "load_voice_pack": engine_module.load_voice_pack,
            "pin_style": engine_module.pin_style,
            "fixed_style_index": engine_module.fixed_style_index,
            "KPipeline": engine_module.KPipeline,
        }

        def restore() -> None:
            for name, value in saved.items():
                setattr(engine_module, name, value)

        self.addCleanup(restore)

        def miss() -> None:
            calls["n"] += 1
            raise engine_module.DrewPackError("no volume")

        engine_module.check_drew_assets = miss
        self.assertFalse(eng.load_drew())
        self.assertIsNone(eng._drew_pipes)

        def hit() -> object:
            calls["n"] += 1
            return type("Assets", (), {"kmodel": "k", "voice": "v"})()

        class Pipe:
            def __init__(self, lang_code: str, repo_id: str, model: object) -> None:
                del lang_code, repo_id, model

        engine_module.check_drew_assets = hit
        engine_module.load_kmodel = lambda path: object()
        engine_module.load_voice_pack = lambda path: torch.zeros(1)
        engine_module.pin_style = lambda pack, index: pack
        engine_module.fixed_style_index = lambda voice: 300
        engine_module.KPipeline = Pipe
        self.assertTrue(eng.load_drew())
        self.assertIsNotNone(eng._drew_pipes)
        self.assertEqual(calls["n"], 2)


class ThreadBudget(unittest.TestCase):
    """`SOWELL_TORCH_THREADS` is the knob; the old name still works."""

    def setUp(self) -> None:
        self._env = {
            key: engine_module.os.environ.get(key)
            for key in (
                "SOWELL_TORCH_THREADS",
                "SOWELL_CPU_THREADS",
                "SOWELL_TORCH_INTEROP_THREADS",
            )
        }
        for key in self._env:
            engine_module.os.environ.pop(key, None)

    def tearDown(self) -> None:
        for key, value in self._env.items():
            if value is None:
                engine_module.os.environ.pop(key, None)
            else:
                engine_module.os.environ[key] = value

    def test_defaults_are_four_io_threads_and_one_interop(self) -> None:
        # Benchmarked on the deployed image: 4 intra-op threads is ~1.5x faster
        # than 2 on Modal's 2 physical cores (RTF 2.06-2.41 vs 1.46-1.57).
        self.assertEqual(engine_module.torch_threads(), 4)
        self.assertEqual(engine_module.cpu_threads(), 4)
        self.assertEqual(engine_module.torch_interop_threads(), 1)

    def test_reads_the_new_name_first(self) -> None:
        engine_module.os.environ["SOWELL_TORCH_THREADS"] = "4"
        engine_module.os.environ["SOWELL_CPU_THREADS"] = "3"
        self.assertEqual(engine_module.torch_threads(), 4)

    def test_falls_back_to_the_older_name(self) -> None:
        engine_module.os.environ["SOWELL_CPU_THREADS"] = "3"
        self.assertEqual(engine_module.torch_threads(), 3)

    def test_clamps_to_one_and_to_the_cpu_count(self) -> None:
        engine_module.os.environ["SOWELL_TORCH_THREADS"] = "0"
        self.assertEqual(engine_module.torch_threads(), 1)
        engine_module.os.environ["SOWELL_TORCH_THREADS"] = "not-a-number"
        self.assertEqual(engine_module.torch_threads(), 4)
        engine_module.os.environ["SOWELL_TORCH_THREADS"] = "9999"
        self.assertEqual(
            engine_module.torch_threads(),
            max(1, min(9999, engine_module.os.cpu_count() or 4)),
        )

    def test_apply_sets_torch_and_is_idempotent(self) -> None:
        engine_module.os.environ["SOWELL_TORCH_THREADS"] = "4"
        self.assertEqual(engine_module.apply_torch_threads(), 4)
        self.assertEqual(torch.get_num_threads(), 4)
        # A second call (a warm container that re-loads) must not raise on the
        # inter-op pool.
        self.assertEqual(engine_module.apply_torch_threads(), 4)
        engine_module.os.environ["SOWELL_TORCH_THREADS"] = "2"
        self.assertEqual(engine_module.apply_torch_threads(), 2)
        self.assertEqual(torch.get_num_threads(), 2)

    def test_legacy_name_delegates(self) -> None:
        engine_module.os.environ["SOWELL_TORCH_THREADS"] = "3"
        self.assertEqual(engine_module.apply_thread_budget(), 3)


class FixedStyle(unittest.TestCase):
    """Drew uses one row for every chunk length. Speed is not part of that."""

    def test_pin_repeats_one_row_and_none_is_the_same_tensor(self) -> None:
        pack = torch.arange(510 * 256, dtype=torch.float32).reshape(510, 1, 256)
        self.assertFalse(torch.equal(pack[99], pack[449]))
        pinned = pin_style(pack, DREW_FIXED_STYLE_INDEX)
        self.assertEqual(tuple(pinned.shape), (510, 1, 256))
        for phonemes in (100, 250, 450, 510):
            # Kokoro selects pack[len(phonemes) - 1].
            torch.testing.assert_close(pinned[phonemes - 1], pack[DREW_FIXED_STYLE_INDEX])
        self.assertIs(pin_style(pack, None), pack)
        with self.assertRaises(Exception):
            pin_style(pack, 510)
        with self.assertRaises(Exception):
            pin_style(pack, True)  # type: ignore[arg-type]

    def test_only_drew_is_pinned(self) -> None:
        self.assertEqual(DREW_FIXED_STYLE_INDEX, 300)
        self.assertIsNone(SOWELL_FIXED_STYLE_INDEX)
        self.assertEqual(fixed_style_index("drew"), 300)
        self.assertIsNone(fixed_style_index("am_sowell"))
        self.assertIsNone(fixed_style_index("bm_george"))
        self.assertIsNone(fixed_style_index("af_heart"))

    def test_render_sees_one_vector_and_the_same_speed(self) -> None:
        eng, seen = DrewSpeedMultiply.engine(self)  # type: ignore[arg-type]
        pack = pin_style(
            torch.arange(510 * 256, dtype=torch.float32).reshape(510, 1, 256),
            DREW_FIXED_STYLE_INDEX,
        )
        received: list[torch.Tensor] = []

        class Recording:
            @staticmethod
            def infer(model, phonemes, voice_pack, speed):
                del model
                received.append(voice_pack[len(phonemes) - 1].clone())
                seen.append(speed)
                return type("Out", (), {"audio": torch.zeros(SAMPLE_RATE)})()

        # The helper already appended nothing; replace its pipeline and clear
        # the speed list the helper's own infer would have filled.
        seen.clear()
        eng._drew_pack = pack
        engine_module.KPipeline = Recording

        def runs(pipeline, tokens):
            del pipeline, tokens
            yield "one", "a" * 100
            yield "two", "b" * 250
            yield "three", "c" * 450
            yield "four", "d" * 510

        engine_module.iter_phoneme_runs = runs
        _wav, report = eng.speak(
            "one two three four", Path("unused"), voice="drew", speed=1.0
        )
        self.assertEqual(seen, [1.0, 1.0, 1.0, 1.0])
        self.assertEqual(report["speed"], 1.0)
        self.assertEqual(report["styleIndex"], 300)
        self.assertEqual(len(received), 4)
        for row in received:
            torch.testing.assert_close(row, pack[DREW_FIXED_STYLE_INDEX])


if __name__ == "__main__":
    unittest.main()
