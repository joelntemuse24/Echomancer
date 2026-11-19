"""Prosody G: sentence types, one forward, and a contour edit that stays in noise.

The planner tests are pure Python. The contour tests need numpy and torch,
which the Sowell image has and a bare checkout may not. They skip, they do
not pretend to pass.
"""

from __future__ import annotations

import json
import os
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prosody_rules import (  # noqa: E402
    FPS_F0,
    PROSODY_G,
    PROSODY_G_CACHE_SUFFIX,
    drew_prosody_enabled,
    grapheme_sentences,
    phoneme_bounds,
    plan_chunks,
    resolve_prosody,
)

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "drew_prosody_passage.json"


def _restore_env(saved: str | None) -> None:
    if saved is None:
        os.environ.pop("DREW_PROSODY_RULES", None)
    else:
        os.environ["DREW_PROSODY_RULES"] = saved


def _kinds(text: str) -> list[str]:
    return [kind for _text, kind in grapheme_sentences(text)]


class Recipe(unittest.TestCase):
    def test_g_is_the_blind_ab_contour_and_the_cache_suffix(self) -> None:
        # Variant G from the 2026-11-19 A/B. These are not environment knobs.
        self.assertEqual(PROSODY_G.name, "G")
        self.assertEqual(PROSODY_G.accent_k, 0.7)
        self.assertEqual(PROSODY_G.decl_st, 3.0)
        self.assertEqual(PROSODY_G.excl_short_st, 4.0)
        self.assertEqual(PROSODY_G.excl_long_st, 1.5)
        self.assertEqual(PROSODY_G.excl_range, 1.15)
        self.assertEqual(PROSODY_G.excl_short_chars, 40)
        self.assertEqual(PROSODY_G.q_rise_st, 7.0)
        self.assertEqual(PROSODY_G.q_win_s, 0.55)
        self.assertEqual(PROSODY_G_CACHE_SUFFIX, "-prosodyG")
        self.assertEqual(FPS_F0, 160.0)

    def test_flag_defaults_off_and_only_explicit_on_values_enable_it(self) -> None:
        self.assertFalse(drew_prosody_enabled({}))
        self.assertFalse(drew_prosody_enabled({"DREW_PROSODY_RULES": ""}))
        self.assertFalse(drew_prosody_enabled({"DREW_PROSODY_RULES": "0"}))
        self.assertFalse(drew_prosody_enabled({"DREW_PROSODY_RULES": "false"}))
        self.assertFalse(drew_prosody_enabled({"DREW_PROSODY_RULES": "off"}))
        for value in ("1", "true", "on", "yes", " TRUE "):
            self.assertTrue(drew_prosody_enabled({"DREW_PROSODY_RULES": value}), value)

    def test_only_drew_takes_the_recipe(self) -> None:
        env = {"DREW_PROSODY_RULES": "1"}
        self.assertIsNone(resolve_prosody("am_sowell", "G", env))
        self.assertIsNone(resolve_prosody("bm_george", None, env))
        self.assertIsNone(resolve_prosody("drew", "", env))
        self.assertIsNone(resolve_prosody("drew", None, {}))
        self.assertEqual(resolve_prosody("drew", None, env), PROSODY_G)
        self.assertEqual(resolve_prosody("drew", "G", {}), PROSODY_G)
        with self.assertRaises(ValueError):
            resolve_prosody("drew", "F", {})


class SentenceTypes(unittest.TestCase):
    def test_passage_kinds_match_the_seven_sentences_the_ab_measured(self) -> None:
        paragraphs = json.loads(FIXTURE.read_text())
        # The engine collapses whitespace before G2P, so the two paragraphs
        # are one string. The exclamation still closes its own sentence.
        text = " ".join(" ".join(paragraphs).split())
        self.assertEqual(
            _kinds(text),
            ["stmt", "excl", "qyn", "excl", "excl", "qyn", "qwh"],
        )
        # What's is not in the wh-list. What is. That is the A/B's classifier.
        sentences = grapheme_sentences(text)
        self.assertTrue(sentences[5][0].startswith("What's"))
        self.assertEqual(sentences[5][1], "qyn")
        self.assertTrue(sentences[6][0].startswith("What would"))
        self.assertEqual(sentences[6][1], "qwh")

    def test_quotes_questions_lists_headings_and_decimals(self) -> None:
        self.assertEqual(
            _kinds('He said. "Is it not monstrous?"'),
            ["stmt", "qyn"],
        )
        self.assertEqual(
            _kinds("1. The harbor is quiet. 2. What is Hecuba?"),
            ["stmt", "stmt", "stmt", "qwh"],
        )
        # A heading with its period is its own statement. The question after
        # it keeps its own first word.
        self.assertEqual(
            _kinds("Chapter One. Is it not monstrous?"),
            ["stmt", "qyn"],
        )
        # A heading with no period was already joined to the next sentence
        # by the engine's whitespace collapse. The kind is the merged sentence.
        self.assertEqual(_kinds("Chapter One Is it not monstrous?"), ["qyn"])
        self.assertEqual(_kinds("The value is 3.14 exactly."), ["stmt"])
        self.assertEqual(len(phoneme_bounds("The value is 3.14 exactly.")), 1)
        # "Dr." is its own statement, same as the A/B splitter: the period
        # has a space after it.
        self.assertEqual(_kinds("Dr. Smith stayed home."), ["stmt", "stmt"])
        self.assertEqual(_kinds("Wait… Don't go?"), ["stmt", "qyn"])
        self.assertEqual(_kinds("Wait... Don't go?"), ["stmt", "qyn"])
        self.assertEqual(len(phoneme_bounds('He said. "Is it?"')), 2)

    def test_a_split_question_keeps_the_first_words_type(self) -> None:
        # Production cuts at 510 phonemes. The tail chunk must not reclassify
        # "That I have?" as a yes/no question just because it starts with That.
        sentence = "What would he do had he the motive and the cue for passion that I have?"
        cut = sentence.index(" that ")
        chunks = [
            (sentence[:cut], sentence[:cut]),
            (sentence[cut + 1 :], sentence[cut + 1 :]),
        ]
        plans = plan_chunks(chunks)
        self.assertEqual([span.kind for span in plans[0]], ["qwh"])
        self.assertEqual([span.kind for span in plans[1]], ["qwh"])
        self.assertFalse(plans[0][0].ends_here)
        self.assertTrue(plans[1][0].ends_here)
        self.assertEqual(plans[0][0].sent_offset, 0)
        self.assertGreater(plans[1][0].sent_offset, 0)
        self.assertEqual(plans[0][0].sent_len, plans[1][0].sent_len)
        self.assertGreater(plans[0][0].sent_len, 40)

    def test_a_split_exclamation_uses_the_full_length(self) -> None:
        # 50 phoneme characters is a long exclamation (1.5 st), even when the
        # first chunk is under the 40-character short threshold.
        body = ("Go now this is surely a long exclamation indeed!" + "x" * 20)[:49] + "!"
        self.assertEqual(len(body), 50)
        cut = 30
        plans = plan_chunks([(body[:cut], body[:cut]), (body[cut:], body[cut:])])
        self.assertEqual(plans[0][0].kind, "excl")
        self.assertEqual(plans[1][0].kind, "excl")
        self.assertGreaterEqual(plans[0][0].sent_len, 40)
        self.assertFalse(plans[0][0].ends_here)
        self.assertTrue(plans[1][0].ends_here)

    def test_one_chunk_plans_a_rise_only_on_the_question_that_ends_there(self) -> None:
        text = "The harbor was quiet. Is it monstrous? What is Hecuba!"
        # The last mark is an exclamation, not a question.
        plans = plan_chunks([(text, text)])
        kinds = [(span.kind, span.ends_here) for span in plans[0]]
        self.assertEqual(kinds, [("stmt", True), ("qyn", True), ("excl", True)])


def _torch():
    try:
        import torch
    except ImportError:
        return None
    return torch


def _shifts(phonemes: str, sentences, hz: float = 110.0, dur: int = 4):
    """Semitone move of each F0 frame. Flat input, so the move is the rule."""
    torch = _torch()
    if torch is None:
        raise unittest.SkipTest("torch is not installed")
    from prosody_rules import _token_chars, edit_f0

    class Vocab:
        def get(self, char: str):
            return 1

    tokens = len(_token_chars(phonemes, Vocab()))
    pred = torch.full((tokens,), dur, dtype=torch.long)
    frames = int(pred.sum().item()) * 2
    f0 = torch.full((1, frames), hz)
    edited = edit_f0(f0, pred, Vocab(), phonemes, PROSODY_G, sentences)
    import numpy as np

    original = f0[0].numpy()
    got = edited[0].detach().cpu().numpy()
    return 12.0 * np.log2(np.maximum(got, 1.0) / np.maximum(original, 1.0)), got, original


class Contour(unittest.TestCase):
    def setUp(self) -> None:
        if _torch() is None:
            self.skipTest("torch is not installed")

    def test_a_statement_declines_about_three_semitones(self) -> None:
        text = "The harbor was quiet after the long rain and the road home."
        span = plan_chunks([(text, text)])[0]
        shifts, _got, _original = _shifts(text, span)
        # Quarters of a +1.5 → −1.5 line sit about 2.2 st apart. Edge
        # smoothing of the scale envelope does not eat that.
        quarter = max(1, len(shifts) // 4)
        drop = float(shifts[:quarter].mean() - shifts[-quarter:].mean())
        self.assertGreater(drop, 2.0)
        self.assertLess(drop, 2.8)
        self.assertLess(float(abs(shifts).max()), 3.2)

    def test_a_yes_no_question_rises_and_a_wh_question_does_not(self) -> None:
        yes_no = "Is the harbor quiet after the long rain this evening?"
        wh = "What is the harbor like after the long rain this evening?"
        yes_shifts, _, _ = _shifts(yes_no, plan_chunks([(yes_no, yes_no)])[0])
        wh_shifts, _, _ = _shifts(wh, plan_chunks([(wh, wh)])[0])
        # Last 0.3 s against the first quarter. The rise is 7 st on the
        # last 0.55 s; declination on its own would still be falling.
        tail = max(1, int(0.3 * FPS_F0))
        yes_move = float(yes_shifts[-tail:].mean() - yes_shifts[: len(yes_shifts) // 4].mean())
        wh_move = float(wh_shifts[-tail:].mean() - wh_shifts[: len(wh_shifts) // 4].mean())
        # Net of the +7 st rise, the 3 st declination, and the 60 ms box
        # (its kernel hangs off the end, so the last frames are not +7).
        # The wh-question only declines, so the gap is the rise.
        self.assertGreater(yes_move, 2.0)
        self.assertLess(wh_move, 0.0)
        self.assertGreater(yes_move - wh_move, 4.0)

    def test_exclamation_register_follows_the_full_sentence_length(self) -> None:
        short = "For Hecuba!"
        long = "It becomes obvious that the only hope is to become a showman!"
        self.assertLess(len(short), 40)
        self.assertGreater(len(long), 40)
        short_shifts, _, _ = _shifts(short, plan_chunks([(short, short)])[0], dur=8)
        long_shifts, _, _ = _shifts(long, plan_chunks([(long, long)])[0])
        # The middle of the sentence is away from the 60 ms edge smooth,
        # so the register shift is the rule and not the declination.
        def middle(shifts):
            a = len(shifts) // 3
            b = 2 * len(shifts) // 3
            return float(shifts[a:b].mean())

        self.assertAlmostEqual(middle(short_shifts), 4.0, delta=0.4)
        self.assertAlmostEqual(middle(long_shifts), 1.5, delta=0.4)

        body = ("Go now this is surely a long exclamation indeed!" + "x" * 20)[:49] + "!"
        cut = 30
        plans = plan_chunks([(body[:cut], body[:cut]), (body[cut:], body[cut:])])
        left, _, _ = _shifts(body[:cut], plans[0], dur=6)
        right, _, _ = _shifts(body[cut:], plans[1], dur=6)
        # A 30-character piece of a 50-character exclamation is still the
        # long register, not the short +4 st one.
        self.assertLess(float(left.mean()), 2.5)
        self.assertLess(float(right.mean()), 2.5)

    def test_the_rise_stays_on_the_chunk_that_holds_the_question_mark(self) -> None:
        sentence = "What would he do had he the motive and the cue for passion that I have?"
        # Yes/no would rise. This one is wh, so neither chunk rises. Swap the
        # first word to force a yes/no split and check the rise is only on
        # the ending chunk — a mid-sentence chunk must not restart it.
        yes_no = "Is it right " + sentence[sentence.index("had") :]
        cut = yes_no.index(" that ")
        plans = plan_chunks(
            [(yes_no[:cut], yes_no[:cut]), (yes_no[cut + 1 :], yes_no[cut + 1 :])]
        )
        self.assertEqual(plans[0][0].kind, "qyn")
        self.assertFalse(plans[0][0].ends_here)
        left, _, _ = _shifts(yes_no[:cut], plans[0])
        right, _, _ = _shifts(yes_no[cut + 1 :], plans[1])
        self.assertLess(float(left.max()), 2.0)
        self.assertGreater(float(right[-max(1, int(0.3 * FPS_F0)) :].mean()), 2.0)

    def test_unvoiced_frames_and_non_finite_contours_are_left_alone(self) -> None:
        torch = _torch()
        import numpy as np
        from prosody_rules import _token_chars, edit_f0

        class Vocab:
            def get(self, char: str):
                return 1

        text = "Is the harbor quiet after the long rain this evening?"
        tokens = len(_token_chars(text, Vocab()))
        pred = torch.full((tokens,), 4, dtype=torch.long)
        frames = int(pred.sum().item()) * 2
        f0 = torch.full((1, frames), 110.0)
        f0[0, :8] = 0
        f0[0, 8:12] = 30  # Kokoro's unvoiced mark is 40 Hz
        edited = edit_f0(f0, pred, Vocab(), text, PROSODY_G, plan_chunks([(text, text)])[0])
        got = edited[0].detach().cpu().numpy()
        self.assertTrue(np.array_equal(got[:12], f0[0, :12].numpy()))
        self.assertTrue(bool(np.isfinite(got).all()))

        broken = f0.clone()
        broken[0, frames // 2] = float("inf")
        returned = edit_f0(
            broken, pred, Vocab(), text, PROSODY_G, plan_chunks([(text, text)])[0]
        )
        self.assertIs(returned, broken)

    def test_a_spike_cannot_jump_an_octave_and_the_rise_has_no_step(self) -> None:
        torch = _torch()
        import numpy as np
        from prosody_rules import _token_chars, edit_f0

        class Vocab:
            def get(self, char: str):
                return 1

        text = "The harbor was quiet after the long rain and the road home today."
        tokens = len(_token_chars(text, Vocab()))
        pred = torch.full((tokens,), 4, dtype=torch.long)
        frames = int(pred.sum().item()) * 2
        f0 = torch.full((1, frames), 110.0)
        # 80 st above the phrase. Compression would move it 24 st. The guard
        # stops at 18, which is still short of two octaves (24 st).
        spike = frames // 2
        f0[0, spike] = 110.0 * 2 ** (80 / 12)
        edited = edit_f0(f0, pred, Vocab(), text, PROSODY_G, plan_chunks([(text, text)])[0])
        got = edited[0].detach().cpu().numpy()
        shift = 12.0 * np.log2(got[spike] / f0[0, spike].item())
        self.assertGreater(abs(float(shift)), 17.0)
        self.assertLessEqual(abs(float(shift)), 18.0 + 1e-3)

        question = "Is the harbor quiet after the long rain this evening?"
        shifts, _, _ = _shifts(question, plan_chunks([(question, question)])[0])
        step = float(np.max(np.abs(np.diff(shifts))))
        # 1.5 st is half the declination, where the first assigned frame
        # meets the boundary token. An octave is 12. A buzz is not this.
        self.assertLess(step, 2.0)

    def test_the_edit_is_inside_the_noise_of_a_section(self) -> None:
        # 51 s at the F0 frame rate, one forward's contour. The A/B's plain
        # renders of this passage varied by about a second on the same box.
        torch = _torch()
        from prosody_rules import edit_f0

        class Vocab:
            def get(self, char: str):
                return 1

        frames = int(51 * FPS_F0)
        # dur 2 and the 2x upsample → 4 frames per token, plus boundaries.
        tokens = frames // 4
        phonemes = "a" * (tokens - 2) + "."
        # Rebuild so the token count matches a real duration vector.
        from prosody_rules import _token_chars

        tokens = len(_token_chars(phonemes, Vocab()))
        pred = torch.full((tokens,), 2, dtype=torch.long)
        f0 = torch.full((1, int(pred.sum().item()) * 2), 110.0)
        sentences = plan_chunks([(phonemes, phonemes)])[0]
        edit_f0(f0, pred, Vocab(), phonemes, PROSODY_G, sentences)
        samples = []
        for _ in range(5):
            started = time.perf_counter()
            edit_f0(f0, pred, Vocab(), phonemes, PROSODY_G, sentences)
            samples.append((time.perf_counter() - started) * 1000)
        median = sorted(samples)[len(samples) // 2]
        # A section of this length took ~10 s of model time. Tens of
        # milliseconds on the contour is inside that run-to-run noise.
        self.assertLess(median, 80, f"edit took {median:.2f} ms")


class OneForward(unittest.TestCase):
    def setUp(self) -> None:
        torch = _torch()
        if torch is None:
            self.skipTest("torch is not installed")
        self.torch = torch

    def _model(self, frames: int):
        torch = self.torch

        class Predictor:
            def __init__(self) -> None:
                self.duration_proj = self._duration
                self.F0Ntrain = self._f0
                self.frames = frames

            def _duration(self, features):
                return torch.zeros(features.shape)

            def _f0(self, aligned, style):
                return torch.full((1, self.frames), 110.0), torch.zeros(1, self.frames)

        class Model:
            def __init__(self) -> None:
                self.predictor = Predictor()
                self.vocab = {chr(code): 1 for code in range(32, 127)}

        return Model()

    def test_hooks_edit_one_call_and_restore_after_an_error(self) -> None:
        from prosody_rules import prosody_hooks

        text = "Is the harbor quiet after the long rain this evening?"
        model = self._model(frames=400)
        original_f0 = model.predictor.F0Ntrain
        original_duration = model.predictor.duration_proj
        sentences = plan_chunks([(text, text)])[0]
        with prosody_hooks(model, text, 0.88, PROSODY_G, sentences):
            self.assertIsNot(model.predictor.F0Ntrain, original_f0)
            features = self.torch.zeros(1, 48, 1)
            model.predictor.duration_proj(features)
            edited, _noise = model.predictor.F0Ntrain(None, None)
        self.assertIs(model.predictor.F0Ntrain, original_f0)
        self.assertIs(model.predictor.duration_proj, original_duration)
        self.assertFalse(bool(self.torch.allclose(edited, self.torch.full_like(edited, 110.0))))

        def boom(aligned, style):
            raise RuntimeError("predictor failed")

        model.predictor.F0Ntrain = boom
        with self.assertRaises(RuntimeError):
            with prosody_hooks(model, text, 0.88, PROSODY_G, sentences):
                model.predictor.duration_proj(self.torch.zeros(1, 48, 1))
                model.predictor.F0Ntrain(None, None)
        self.assertIs(model.predictor.F0Ntrain, boom)

    def test_a_real_duration_linear_is_hooked_and_left_in_place(self) -> None:
        # Kokoro's duration_proj is an nn.Linear. Assigning a function to it
        # raises TypeError. The hook has to leave the module where it is.
        from prosody_rules import prosody_hooks

        torch = self.torch

        class Predictor(torch.nn.Module):
            def __init__(self) -> None:
                super().__init__()
                self.duration_proj = torch.nn.Linear(4, 3)
                self._f0 = lambda aligned, style: (
                    torch.full((1, 64), 110.0),
                    torch.zeros(1, 64),
                )
                self.F0Ntrain = self._f0

        class Model(torch.nn.Module):
            def __init__(self) -> None:
                super().__init__()
                self.predictor = Predictor()
                self.vocab = {chr(code): 1 for code in range(32, 127)}

        model = Model()
        linear = model.predictor.duration_proj
        text = "Is the harbor quiet after the long rain this evening?"
        sentences = plan_chunks([(text, text)])[0]
        with prosody_hooks(model, text, 0.88, PROSODY_G, sentences):
            self.assertIs(model.predictor.duration_proj, linear)
            model.predictor.duration_proj(torch.zeros(1, 8, 4))
            edited, _noise = model.predictor.F0Ntrain(None, None)
        self.assertIs(model.predictor.duration_proj, linear)
        self.assertFalse(bool(torch.allclose(edited, torch.full_like(edited, 110.0))))

    def test_the_engine_calls_infer_once_per_chunk_and_not_at_all_extra(self) -> None:
        import engine as engine_module
        from engine import SAMPLE_RATE, SowellEngine

        text = "Hello harbor."
        saved = os.environ.pop("DREW_PROSODY_RULES", None)
        self.addCleanup(lambda: _restore_env(saved))

        def run(prosody: str | None) -> dict:
            calls = {"n": 0, "wrapped": []}
            model = self._model(frames=64)
            original = model.predictor.F0Ntrain

            class Pipeline:
                def __init__(self) -> None:
                    self.model = model

                def g2p(self, value: str):
                    return None, [value]

            class KPipeline:
                @staticmethod
                def infer(used_model, phonemes, pack, speed):
                    del phonemes, pack, speed
                    calls["n"] += 1
                    calls["wrapped"].append(used_model.predictor.F0Ntrain is not original)
                    used_model.predictor.duration_proj(torch_zeros())
                    used_model.predictor.F0Ntrain(None, None)
                    return type("Out", (), {"audio": self.torch.zeros(SAMPLE_RATE)})()

            def torch_zeros():
                return self.torch.zeros(1, 16, 1)

            def runs(pipeline, tokens):
                del pipeline, tokens
                yield "Hello", "Hello"
                yield "harbor.", "harbor."

            eng = SowellEngine()
            eng._drew_pipes = {"a": Pipeline()}
            eng._drew_pack = self.torch.zeros(1)
            previous = engine_module.KPipeline
            previous_runs = engine_module.iter_phoneme_runs
            engine_module.KPipeline = KPipeline
            engine_module.iter_phoneme_runs = runs
            try:
                _wav, report = eng.speak(text, Path("unused"), voice="drew", prosody=prosody)
            finally:
                engine_module.KPipeline = previous
                engine_module.iter_phoneme_runs = previous_runs
            calls["report"] = report
            return calls

        off = run("")
        self.assertEqual(off["n"], 2)
        self.assertEqual(off["wrapped"], [False, False])
        self.assertIsNone(off["report"]["prosody"])

        os.environ["DREW_PROSODY_RULES"] = "1"
        # An empty request still forces the stock forward. The cache key
        # for that request did not move, so the audio must not either.
        forced = run("")
        self.assertEqual(forced["n"], 2)
        self.assertEqual(forced["wrapped"], [False, False])
        self.assertIsNone(forced["report"]["prosody"])

        on = run("G")
        self.assertEqual(on["n"], 2)
        self.assertEqual(on["wrapped"], [True, True])
        self.assertEqual(on["report"]["prosody"], "G")
        self.assertEqual(on["report"]["styleIndex"], 300)

        walter = SowellEngine()
        # Walter's path must ignore a G request. Build it through speak with
        # the stock stub the Drew test uses, and count wraps on a model that
        # would notice.
        model = self._model(frames=64)
        original = model.predictor.F0Ntrain
        seen = {"wrapped": None, "n": 0}

        class Pipeline:
            def __init__(self) -> None:
                self.model = model

            def g2p(self, value: str):
                return None, [value]

        class KPipeline:
            @staticmethod
            def infer(used_model, phonemes, pack, speed):
                del phonemes, pack, speed
                seen["n"] += 1
                seen["wrapped"] = used_model.predictor.F0Ntrain is not original
                return type("Out", (), {"audio": self.torch.zeros(SAMPLE_RATE)})()

        walter._pipelines = {"a": Pipeline(), "b": Pipeline()}
        walter._packs = {"am_sowell": self.torch.zeros(1), "bm_george": self.torch.zeros(1)}
        previous = engine_module.KPipeline
        previous_runs = engine_module.iter_phoneme_runs
        engine_module.KPipeline = KPipeline
        engine_module.iter_phoneme_runs = lambda pipeline, tokens: iter([(text, text)])
        try:
            _wav, report = walter.speak(text, Path("unused"), voice="sowell", prosody="G")
        finally:
            engine_module.KPipeline = previous
            engine_module.iter_phoneme_runs = previous_runs
        self.assertEqual(seen["n"], 1)
        self.assertFalse(seen["wrapped"])
        self.assertIsNone(report["prosody"])


if __name__ == "__main__":
    unittest.main()
