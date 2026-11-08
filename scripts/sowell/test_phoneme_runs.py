"""510/511 phoneme boundary. Kokoro 0.9.4 is the pinned splitter.

No model weights and no synthesis. American is Sowell (lang a). British
is George (lang b). A run of 511 must be split without dropping a phoneme
or a word, and a run of 510 stays one piece.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

from misaki.token import MToken

sys.path.insert(0, str(Path(__file__).resolve().parent))
from engine import iter_phoneme_runs, split_phoneme_run, words
from kokoro import KPipeline
from kokoro.pipeline import KPipeline as KP

PINNED = "hexgrad/Kokoro-82M"
MARKS = ".,;:!?—–…\"'“”()-"


def _pipes() -> dict[str, KPipeline]:
    return {
        lang: KPipeline(lang_code=lang, repo_id=PINNED, model=False)
        for lang in ("a", "b")
    }


def _marks(text: str) -> str:
    return "".join(ch for ch in text if ch in MARKS)


def _token(text: str, phonemes: str, whitespace: str = "") -> MToken:
    return MToken(text=text, tag="X", whitespace=whitespace, phonemes=phonemes)


class PhonemeBoundary(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.pipes = _pipes()

    def test_pinned_tokenizer_emits_511_and_the_split_keeps_it(self) -> None:
        """The guard used to refuse this exact length. Kokoro would truncate it."""
        phonemes = "ɑ" * 511
        for lang, pipeline in self.pipes.items():
            # One token over the cap: an empty split, then the 511-phoneme run.
            raw = [ps for _g, ps, _t in pipeline.en_tokenize([_token("unspaced", phonemes)]) if ps]
            self.assertEqual(raw, [phonemes], lang)
            runs = list(iter_phoneme_runs(pipeline, [_token("unspaced", phonemes)]))
            self.assertGreater(len(runs), 1, lang)
            self.assertTrue(all(len(ps) <= 510 for _text, ps in runs), lang)
            self.assertEqual("".join(ps for _text, ps in runs), phonemes, lang)
            self.assertEqual(words(" ".join(text for text, _ps in runs)), ["unspaced"], lang)

    def test_510_stays_one_run(self) -> None:
        phonemes = "ɑ" * 510
        for lang, pipeline in self.pipes.items():
            raw = list(pipeline.en_tokenize([_token("legal", phonemes)]))
            self.assertEqual(len(raw[0][1]), 510, lang)
            runs = list(iter_phoneme_runs(pipeline, [_token("legal", phonemes)]))
            self.assertEqual(runs, [("legal", phonemes)], lang)

    def test_511_with_spaces_splits_on_a_space_and_keeps_order(self) -> None:
        # 46 groups of 10 letters plus a space is 506, then five letters is 511.
        phonemes = ("abcdefghij " * 46) + "abcde"
        self.assertEqual(len(phonemes), 511)
        token = _token("spacedrun", phonemes)
        for lang, pipeline in self.pipes.items():
            raw = [ps for _g, ps, _t in pipeline.en_tokenize([token]) if ps]
            self.assertEqual(raw, [phonemes], lang)
            runs = list(iter_phoneme_runs(pipeline, [_token("spacedrun", phonemes)]))
            pieces = [ps for _text, ps in runs]
            joined = "".join(pieces)
            self.assertEqual(joined, phonemes, lang)
            self.assertTrue(all(len(ps) <= 510 for ps in pieces), lang)
            # A space inside the window stays on the left piece. No phoneme is cut in half.
            self.assertTrue(all(piece.endswith(" ") for piece in pieces[:-1]), lang)
            self.assertEqual(words(" ".join(text for text, _ps in runs)), ["spacedrun"], lang)

    def test_long_sentence_both_voices_keeps_words_marks_and_order(self) -> None:
        sentence = (
            "The historical evidence, however, shows that the American economy — "
            'and the British record beside it — did not move in a straight line. '
            'Dr. Smith said, "Wait — don\'t skip the 1914–1918 figures," and the '
            "later note (see 3.14) agreed."
        )
        text = " ".join([sentence] * 8)
        self.assertLessEqual(len(text), 2000)
        self.assertGreater(len(text), 1500)
        for lang, label in (("a", "sowell"), ("b", "george")):
            pipeline = self.pipes[lang]
            _ps, tokens = pipeline.g2p(text)
            runs = list(iter_phoneme_runs(pipeline, tokens))
            spoken = " ".join(piece for piece, _ps in runs if piece)
            self.assertTrue(runs, label)
            self.assertTrue(all(0 < len(ps) <= 510 for _text, ps in runs), label)
            self.assertEqual(words(spoken), words(text), label)
            self.assertEqual(_marks(spoken), _marks(text), label)
            # Force the same tokens through as one over-cap run. en_tokenize
            # may already have split them; this is the 511 cutter on real words.
            whole = KP.tokens_to_ps(tokens)
            self.assertGreater(len(whole), 510, label)
            forced = split_phoneme_run(KP.tokens_to_text(tokens), whole, tokens)
            self.assertEqual("".join(ps for _text, ps in forced), whole, label)
            self.assertTrue(all(len(ps) <= 510 for _text, ps in forced), label)
            self.assertEqual(words(" ".join(piece for piece, _ps in forced)), words(text), label)
            self.assertEqual(
                _marks(" ".join(piece for piece, _ps in forced)),
                _marks(KP.tokens_to_text(tokens)),
                label,
            )


if __name__ == "__main__":
    unittest.main()
