"""Pronunciation prep. No misaki, no torch.

The engines call prepare_kokoro_text and install_pronunciations. This
file checks the text rules, the lexicon table, and that both engines
actually call them.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from phoneme_runs import words  # noqa: E402
from pronounce import (  # noqa: E402
    PRONUNCIATION_ID,
    PRONUNCIATIONS,
    install_pronunciations,
    prepare_kokoro_text,
)


class Quotes(unittest.TestCase):
    def test_curly_apostrophe_stays_one_word(self) -> None:
        prepared = prepare_kokoro_text("don\u2019t")
        self.assertEqual(prepared, "don't")
        self.assertEqual(words(prepared), ["don't"])
        # The curly mark is what used to split the token.
        self.assertEqual(words("don\u2019t"), ["don", "t"])

    def test_quotes_and_bar_marks_fold(self) -> None:
        prepared = prepare_kokoro_text("\u201cdon\u2019t\u201d \u2015hello\u2016")
        self.assertIn("don't", prepared)
        self.assertNotIn("\u2019", prepared)
        self.assertNotIn("\u2015", prepared)
        self.assertNotIn("\u2016", prepared)
        self.assertEqual(words(prepared), ["don't", "hello"])


class LetterNumbers(unittest.TestCase):
    def test_glued_token_is_split(self) -> None:
        self.assertEqual(prepare_kokoro_text("See CS183 today."), "See CS 183 today.")

    def test_already_split_token_stays(self) -> None:
        self.assertEqual(prepare_kokoro_text("CS 183"), "CS 183")


class RomanHeadings(unittest.TestCase):
    def test_outline_at_line_start_is_a_number(self) -> None:
        self.assertEqual(prepare_kokoro_text("I. The harbor"), "One. The harbor")
        self.assertEqual(prepare_kokoro_text("II. The harbor"), "Two. The harbor")
        self.assertEqual(prepare_kokoro_text("III. The harbor"), "Three. The harbor")
        self.assertEqual(prepare_kokoro_text("IV. The harbor"), "Four. The harbor")

    def test_paragraph_start(self) -> None:
        self.assertEqual(
            prepare_kokoro_text("A paragraph.\n\nIV. Next"),
            "A paragraph. Four. Next",
        )

    def test_pronoun_i_in_running_text_stays(self) -> None:
        self.assertEqual(prepare_kokoro_text("I went home"), "I went home")
        self.assertEqual(
            prepare_kokoro_text("So do I. Then we left."),
            "So do I. Then we left.",
        )
        self.assertEqual(
            prepare_kokoro_text("The part I. mentioned"),
            "The part I. mentioned",
        )


class Lexicon(unittest.TestCase):
    def test_table_overrides_the_us_gold_shapes(self) -> None:
        self.assertEqual(PRONUNCIATIONS["thiel"], "tˈil")
        self.assertNotIn("θ", PRONUNCIATIONS["thiel"])
        self.assertEqual(PRONUNCIATIONS["deterministic"], "dɪtˌɜɹmɪnˈɪstɪk")
        self.assertNotEqual(PRONUNCIATIONS["deterministic"], "dətˌɜɹmənˈɪstɪk")
        self.assertEqual(PRONUNCIATIONS["indeterminate"], "ˌɪndɪtˈɜɹmᵻnət")
        self.assertEqual(PRONUNCIATIONS["andreessen"], "ændɹˈiːsən")
        for word in ("priceline", "sergey", "assange", "roelof", "determinate", "determinism"):
            self.assertIn(word, PRONUNCIATIONS)
            self.assertTrue(PRONUNCIATIONS[word])

    def test_install_writes_over_existing_golds(self) -> None:
        class Lexicon:
            def __init__(self) -> None:
                self.golds = {"deterministic": "dətˌɜɹmənˈɪstɪk"}

        class G2P:
            def __init__(self) -> None:
                self.lexicon = Lexicon()

        g2p = G2P()
        install_pronunciations(g2p)
        self.assertEqual(g2p.lexicon.golds["deterministic"], "dɪtˌɜɹmɪnˈɪstɪk")
        self.assertEqual(g2p.lexicon.golds["Thiel"], "tˈil")
        self.assertEqual(g2p.lexicon.golds["thiel"], "tˈil")

    def test_install_without_a_lexicon_is_a_no_op(self) -> None:
        install_pronunciations(object())

    def test_cache_id_matches_the_typescript_suffix(self) -> None:
        ts = (
            Path(__file__).resolve().parents[2] / "src/lib/tts/kokoro-pronunciation.ts"
        ).read_text(encoding="utf-8")
        self.assertIn(f'"{PRONUNCIATION_ID}"', ts)


class EnginesCallTheSharedPrep(unittest.TestCase):
    def test_onnx_and_torch_both_prepare_and_install(self) -> None:
        root = Path(__file__).resolve().parent
        for name in ("engine.py", "onnx_engine.py"):
            source = (root / name).read_text(encoding="utf-8")
            self.assertIn("prepare_kokoro_text", source)
            self.assertIn("install_pronunciations", source)


if __name__ == "__main__":
    unittest.main()
