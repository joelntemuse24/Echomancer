"""Phoneme runs for Kokoro, with no torch import.

Shared by the torch engine (`engine.py`) and the ONNX engine
(`onnx_engine.py`), so both speak exactly the same chunks.

`en_tokenize` is Kokoro 0.9.4's `KPipeline.en_tokenize` (Apache-2.0,
hexgrad/kokoro), copied with its two static helpers so the ONNX process never
imports the `kokoro` package (which imports torch at package import).
`test_phoneme_runs.py` checks it against the pinned package token for token.
"""

from __future__ import annotations

import re

PHONEME_CAP = 510
_WORDS = re.compile(r"[A-Za-z0-9']+")


def tokens_to_ps(tokens) -> str:
    return "".join(t.phonemes + (" " if t.whitespace else "") for t in tokens).strip()


def tokens_to_text(tokens) -> str:
    return "".join(t.text + t.whitespace for t in tokens).strip()


def waterfall_last(tokens, next_count: int, waterfall=("!.?…", ":;", ",—"), bumps=(")", "”")) -> int:
    for w in waterfall:
        z = next((i for i, t in reversed(list(enumerate(tokens))) if t.phonemes in set(w)), None)
        if z is None:
            continue
        z += 1
        if z < len(tokens) and tokens[z].phonemes in bumps:
            z += 1
        if next_count - len(tokens_to_ps(tokens[:z])) <= 510:
            return z
    return len(tokens)


def en_tokenize(tokens):
    """Kokoro 0.9.4 `KPipeline.en_tokenize`, verbatim apart from the logging."""
    tks = []
    pcount = 0
    for t in tokens:
        t.phonemes = "" if t.phonemes is None else t.phonemes
        next_ps = t.phonemes + (" " if t.whitespace else "")
        next_pcount = pcount + len(next_ps.rstrip())
        if next_pcount > 510:
            z = waterfall_last(tks, next_pcount)
            text = tokens_to_text(tks[:z])
            ps = tokens_to_ps(tks[:z])
            yield text, ps, tks[:z]
            tks = tks[z:]
            pcount = len(tokens_to_ps(tks))
            if not tks:
                next_ps = next_ps.lstrip()
        tks.append(t)
        pcount += len(next_ps)
    if tks:
        text = tokens_to_text(tks)
        ps = tokens_to_ps(tks)
        yield "".join(text).strip(), "".join(ps).strip(), tks


class Tokenizer:
    """The `pipeline` argument `iter_phoneme_runs` needs, without a KPipeline."""

    @staticmethod
    def en_tokenize(tokens):
        return en_tokenize(tokens)


def words(text: str) -> list[str]:
    return _WORDS.findall(text)


def _token_surface(tokens) -> str:
    """Token text plus each token's own trailing whitespace. Nothing added."""
    return "".join(f"{token.text}{token.whitespace or ''}" for token in tokens)


def spoken_words_match(pipeline, tokens) -> bool:
    """True when every word the tokenizer kept was placed in a spoken chunk.

    ``en_tokenize`` strips each chunk, and ``" ".join`` of those strings
    inserts a space at the cut. A 510-phoneme cut that falls between two
    tokens with no whitespace (``don't`` as ``don`` + ``'t``, ``Holmes's``
    as ``Holmes`` + ``'s``, ``221B`` as ``221`` + ``B``) then fails
    ``words(request) == words(joined)`` even though both tokens were
    spoken. Coverage concatenates each token's own whitespace, so that
    cut still matches, and a chunk skipped for empty phonemes does not.
    """
    given = words(tokens_to_text(tokens))
    parts: list[str] = []
    for _graphemes, phonemes, chunk_tokens in pipeline.en_tokenize(tokens):
        if not phonemes:
            continue
        parts.append(_token_surface(chunk_tokens))
    return given == words("".join(parts))


def iter_phoneme_runs(pipeline, tokens):
    """Yield ``(graphemes, phonemes)`` with each phoneme string at most 510.

    Kokoro 0.9.4 ``en_tokenize`` tries to stay at 510. Its own generator
    then truncates a longer run, which drops speech. This keeps every
    phoneme character: a run of 511 is split on a token boundary, then on
    a space, then at the cap. Joining the pieces returns that run unchanged.
    """
    for graphemes, phonemes, chunk_tokens in pipeline.en_tokenize(tokens):
        if not phonemes:
            continue
        if len(phonemes) <= PHONEME_CAP:
            yield graphemes, phonemes
            continue
        yield from split_phoneme_run(graphemes, phonemes, chunk_tokens)


def split_phoneme_run(graphemes: str, phonemes: str, tokens) -> list[tuple[str, str]]:
    """Split one over-cap run. Pieces join back to ``phonemes`` and stay in order."""
    pieces = _phoneme_pieces(phonemes, tokens)
    if len(pieces) == 1:
        return [(graphemes, pieces[0])]
    spans = _token_spans(tokens, phonemes)
    if not _spans_match(spans, phonemes):
        # The graphemes still have to be spoken once. Park them on the first
        # piece rather than dropping a word when the join cannot be mapped.
        return [(graphemes, pieces[0]), *[("", piece) for piece in pieces[1:]]]
    assigned: list[tuple[str, str]] = []
    cursor = 0
    for index, piece in enumerate(pieces):
        end = cursor + len(piece)
        assigned.append((_graphemes_for(spans, cursor, end), piece))
        cursor = end
    return assigned


def _phoneme_pieces(phonemes: str, tokens) -> list[str]:
    """Cut points that leave every character in order, none added or removed."""
    if len(phonemes) <= PHONEME_CAP:
        return [phonemes]
    spans = _token_spans(tokens, phonemes)
    boundaries = [end for _start, end, _text in spans] if _spans_match(spans, phonemes) else []
    pieces: list[str] = []
    start = 0
    while len(phonemes) - start > PHONEME_CAP:
        window = start + PHONEME_CAP
        cut = 0
        for boundary in boundaries:
            if start < boundary <= window:
                cut = boundary
        if cut <= start:
            space = phonemes.rfind(" ", start + 1, window + 1)
            # Keep the space on the left piece so the pause stays in the run.
            cut = space + 1 if space > start else window
        pieces.append(phonemes[start:cut])
        start = cut
    if start < len(phonemes):
        pieces.append(phonemes[start:])
    return pieces


def _token_spans(tokens, phonemes: str) -> list[tuple[int, int, str]]:
    """Each token's place in the phoneme string Kokoro actually yielded."""
    raw_parts: list[str] = []
    raw_ends: list[int] = []
    texts: list[str] = []
    for token in tokens:
        spoken = "" if token.phonemes is None else token.phonemes
        raw_parts.append(spoken + (" " if token.whitespace else ""))
        raw_ends.append(sum(len(part) for part in raw_parts))
        texts.append(f"{token.text}{token.whitespace}")
    raw = "".join(raw_parts)
    leading = len(raw) - len(raw.lstrip())
    spans: list[tuple[int, int, str]] = []
    previous = 0
    for raw_end, text in zip(raw_ends, texts):
        start = max(0, min(len(phonemes), previous - leading))
        end = max(start, min(len(phonemes), raw_end - leading))
        spans.append((start, end, text))
        previous = raw_end
    return spans


def _spans_match(spans: list[tuple[int, int, str]], phonemes: str) -> bool:
    if not phonemes:
        return True
    if not spans:
        return False
    return spans[-1][1] == len(phonemes)


def _graphemes_for(spans: list[tuple[int, int, str]], start: int, end: int) -> str:
    """Token text that begins in this piece. A hard cut does not repeat it."""
    parts: list[str] = []
    for token_start, token_end, text in spans:
        if token_start == token_end:
            # No phonemes of its own. Keep it once, on the piece that ends here,
            # or on the first piece when it sits at the start.
            on_left_edge = token_end == end and end != start
            at_start = start == 0 and token_start == 0
            if on_left_edge or at_start:
                parts.append(text)
            continue
        if start <= token_start < end:
            parts.append(text)
    return "".join(parts).strip()
