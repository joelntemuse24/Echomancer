"""Tests for the narration shaping in `server.py`.

Run with the sidecar venv from the repo root:

    /opt/echomancer/paradee/venv/bin/python -m unittest discover -s scripts/paradee -p 'test_*.py' -v

A fake engine stands in for Paradee so the layout, trimming and join rules can
be checked without the model: each "call" returns a known shape with a padded
front, a body and a padded tail.
"""

import importlib.util
import os
import sys
import types
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def _load_server():
    """Import server.py without the onnxruntime / misaki stack it imports lazily."""
    spec = importlib.util.spec_from_file_location(
        "paradee_sidecar_server", os.path.join(HERE, "server.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


server = _load_server()

SR = server.SAMPLE_RATE


class FakeEngine:
    """Deterministic stand-in: one tone burst wrapped in the model's padding.

    The real graph pads by roughly (300 ms before, 450 ms after) and the amount
    grows with the text, so the deviations here exercise the measured path
    rather than a fixed trim.
    """

    def __init__(self, pad_scale=1.0):
        self.calls = []
        self.pad_scale = pad_scale

    def phonemize(self, text):
        # ~1.2 characters per phoneme keeps the sizes in the real range.
        return "a" * max(1, int(len(text) * 1.2))

    def generate_from_phonemes(self, phonemes, speed=1.0):
        self.calls.append(phonemes)
        body_s = max(0.25, len(phonemes) / 90.0)
        lead = int(0.300 * self.pad_scale * SR * (1 + len(phonemes) / 4000))
        tail = int(0.450 * self.pad_scale * SR * (1 + len(phonemes) / 4000))
        n = int(body_s * SR)
        body = 0.2 * np.sin(
            2 * np.pi * 140.0 * np.arange(n, dtype=np.float32) / SR
        ).astype(np.float32)
        return np.concatenate(
            [np.zeros(lead, np.float32), body, np.zeros(tail, np.float32)]
        )


def _paragraph(n_sentences):
    return " ".join(
        f"And then the {i} bank, which is to say a library of that name." + "."
        for i in range(n_sentences)
    )


class ChunkPlanTests(unittest.TestCase):
    def setUp(self):
        self.engine = FakeEngine()

    def test_short_paragraph_is_one_call(self):
        text = "She waited by the water. The rain came late."
        chunks = server.plan_chunks(self.engine, text)
        self.assertEqual(len(chunks), 1, [c.phonemes for c in chunks])
        self.assertEqual(chunks[0].gap_before_ms, 0)

    def test_paragraph_break_gets_the_long_gap(self):
        text = "First paragraph here.\n\nSecond paragraph here."
        chunks = server.plan_chunks(self.engine, text)
        self.assertGreaterEqual(len(chunks), 1)
        gaps = [c.gap_before_ms for c in chunks]
        self.assertEqual(gaps[0], 0)
        for gap in gaps[1:]:
            self.assertIn(gap, (server.SENTENCE_GAP_MS, server.PARAGRAPH_GAP_MS))

    def test_sentence_punctuation_is_never_rewritten(self):
        text = "One thing. Another thing."
        chunks = server.plan_chunks(self.engine, text)
        joined = " ".join(c.phonemes for c in chunks)
        # The engine is a fake, so assert on the text handed to phonemize.
        self.assertNotIn(",", joined)

    def test_no_call_exceeds_the_graph_budget(self):
        text = _paragraph(12)
        chunks = server.plan_chunks(self.engine, text)
        for chunk in chunks:
            self.assertLessEqual(len(chunk.phonemes), server.MAX_PHONEMES)

    def test_no_stub_final_call(self):
        # A paragraph that spills over used to leave a one-word last call.
        for n in range(2, 20):
            text = _paragraph(n)
            chunks = server.plan_chunks(self.engine, text)
            if len(chunks) > 1:
                self.assertGreaterEqual(
                    len(chunks[-1].phonemes),
                    server.MIN_STANDALONE_PHONEMES,
                    f"{n} sentences left a stub: {[len(c.phonemes) for c in chunks]}",
                )

    def test_empty_text_plans_nothing(self):
        self.assertEqual(server.plan_chunks(self.engine, "   "), [])


class TrimTests(unittest.TestCase):
    def test_trims_model_padding_and_keeps_a_bed(self):
        engine = FakeEngine()
        audio = engine.generate_from_phonemes("a" * 200)
        trimmed = server.trim_padding(audio)
        self.assertLess(trimmed.size, audio.size)
        keep_ms = server.LEAD_SILENCE_KEEP_MS + server.TAIL_SILENCE_KEEP_MS
        # The body survives; only the model's padding is dropped.
        body = audio.size - int(0.750 * SR * (1 + 200 / 4000))
        self.assertGreaterEqual(trimmed.size, body)
        self.assertLessEqual(trimmed.size, body + int(keep_ms / 1000 * SR) + 2)

    def test_fully_silent_take_becomes_empty(self):
        self.assertEqual(server.trim_padding(np.zeros(SR, np.float32)).size, 0)

    def test_edge_fades_do_not_change_length(self):
        audio = FakeEngine().generate_from_phonemes("a" * 120)
        self.assertEqual(server._apply_edge_fades(audio).size, audio.size)


class JoinTests(unittest.TestCase):
    def test_room_tone_removes_digital_zeros(self):
        engine = FakeEngine()
        server._tts = engine
        try:
            audio = server._synth("She waited. The rain came late.", 1.0)
        finally:
            server._tts = None
        self.assertGreater(float(np.mean(np.abs(audio) < 1e-7)), 0.05)
        pcm = server._pcm_s16le(audio, seed=7)
        out = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        self.assertLess(float(np.mean(np.abs(out) < 1e-6)) * 100, 2.0)

    def test_seeded_tone_is_reproducible(self):
        audio = FakeEngine().generate_from_phonemes("a" * 100)
        a = server._pcm_s16le(audio, seed=99)
        b = server._pcm_s16le(audio, seed=99)
        self.assertEqual(a, b)
        self.assertNotEqual(a, server._pcm_s16le(audio, seed=100))

    def test_peak_stays_below_the_clip_guard(self):
        loud = np.full(SR, 0.9, dtype=np.float32)
        out = np.frombuffer(server._pcm_s16le(loud, seed=1), dtype="<i2")
        self.assertLessEqual(int(np.max(np.abs(out.astype(np.int32)))), 32767)
        self.assertLess(float(np.max(np.abs(out))) / 32767.0, 1.0)


class RequestTests(unittest.TestCase):
    def test_speed_is_clamped(self):
        self.assertEqual(server.MIN_SPEED, 0.5)
        self.assertEqual(server.MAX_SPEED, 2.0)


if __name__ == "__main__":
    unittest.main()
