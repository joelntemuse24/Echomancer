"""The spoken-text check must not reject a 510-phoneme cut inside a word.

``" ".join`` of stripped chunk graphemes inserts a space. A cut between
two tokens that had no whitespace (a contraction, a possessive, or a
letter glued to a number) used to fail the check on every attempt.
Coverage keeps each token's own whitespace. A chunk that was not spoken
still fails.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from phoneme_runs import Tokenizer, spoken_words_match, tokens_to_text, words


class Tok:
    def __init__(self, text: str, phonemes: str, whitespace: str = "") -> None:
        self.text = text
        self.phonemes = phonemes
        self.whitespace = whitespace


def _glued(left: str, right: str) -> list[Tok]:
    """A short lead, then two tokens the 510 cut has to separate."""
    return [
        Tok("The", "a" * 400, " "),
        Tok(left, "b" * 120, ""),
        Tok(right, "c" * 400, " "),
    ]


class SpokenWordCoverage(unittest.TestCase):
    def test_glued_number_and_letter_survives_the_cut(self) -> None:
        tokens = _glued("221", "B")
        chunks = [text for text, phonemes, _t in Tokenizer.en_tokenize(tokens) if phonemes]
        # The old check. The space at the cut splits 221B into two words.
        self.assertEqual(words(" ".join(chunk.strip() for chunk in chunks)), ["The", "221", "B"])
        self.assertTrue(spoken_words_match(Tokenizer, tokens))
        self.assertEqual(words(tokens_to_text(tokens)), ["The", "221B"])

    def test_possessive_survives_the_cut(self) -> None:
        tokens = _glued("Holmes", "'s")
        self.assertTrue(spoken_words_match(Tokenizer, tokens))
        self.assertEqual(words(tokens_to_text(tokens)), ["The", "Holmes's"])

    def test_contraction_survives_the_cut(self) -> None:
        tokens = _glued("don", "'t")
        self.assertTrue(spoken_words_match(Tokenizer, tokens))
        self.assertEqual(words(tokens_to_text(tokens)), ["The", "don't"])

    def test_a_chunk_that_was_not_spoken_still_fails(self) -> None:
        # The word has no phonemes, and the next token is too long to share
        # its chunk, so the word is yielded alone and then skipped.
        tokens = [
            Tok("street", "", " "),
            Tok("name", "c" * 510, " "),
        ]
        self.assertFalse(spoken_words_match(Tokenizer, tokens))


if __name__ == "__main__":
    unittest.main()
