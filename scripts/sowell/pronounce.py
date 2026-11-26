"""Text Kokoro hears, and a small lexicon checked before misaki us_gold.

Both engines call this before G2P:

* ``onnx_engine.py`` (Modal ONNX, and any CPU process on that runtime)
* ``engine.py`` (torch)

Add a word by putting a lowercase key in ``PRONUNCIATIONS``. The value is
espeak-style American IPA. Then bump ``PRONUNCIATION_ID`` here and
``KOKORO_PRONUNCIATION_ID`` in ``src/lib/tts/kokoro-pronunciation.ts``
together, so a cached section or preview is not replayed with the old
phonemes. Nothing in this module is a second model pass.

``us_gold`` says deterministic as ``dətˌɜɹmənˈɪstɪk``. The entries below
are the espeak shapes (``dɪtˌɜɹmɪnˈɪstɪk``, ``ˌɪndɪtˈɜɹmᵻnət``). Thiel is
``tˈil``; espeak's own fallback is ``θˈil``, which is the reading we do
not want. The other names are the espeak-style forms.
"""

from __future__ import annotations

import re

# Bump with src/lib/tts/kokoro-pronunciation.ts when the table changes.
PRONUNCIATION_ID = "lex1"

PRONUNCIATIONS: dict[str, str] = {
    "thiel": "tˈil",
    "andreessen": "ændɹˈiːsən",
    "priceline": "pɹˈaɪslaɪn",
    "sergey": "sˈɛɹɡeɪ",
    "assange": "æsˈɑːndʒ",
    "roelof": "ɹˈuːlɔf",
    "determine": "dɪtˈɜɹmɪn",
    "determined": "dɪtˈɜɹmɪnd",
    "determines": "dɪtˈɜɹmɪnz",
    "determining": "dɪtˈɜɹmɪnɪŋ",
    "determination": "dɪtˌɜɹmɪnˈeɪʃən",
    "determinations": "dɪtˌɜɹmɪnˈeɪʃənz",
    "determinate": "dɪtˈɜɹmᵻnət",
    "determinism": "dɪtˈɜɹmɪnˌɪzəm",
    "determinist": "dɪtˈɜɹmɪnɪst",
    "deterministic": "dɪtˌɜɹmɪnˈɪstɪk",
    "deterministically": "dɪtˌɜɹmɪnˈɪstɪkli",
    "indeterminate": "ˌɪndɪtˈɜɹmᵻnət",
    "indeterminacy": "ˌɪndɪtˈɜɹmɪnəsi",
    "indetermination": "ˌɪndɪtɜɹmɪnˈeɪʃən",
    "undetermined": "ˌʌndɪtˈɜɹmɪnd",
}

# Typographic quotes and the two marks this corpus uses as quotes.
# U+2019 inside "don't" must become ASCII before G2P, or the word splits.
_QUOTE_FOLD = str.maketrans(
    {
        "\u2018": "'",
        "\u2019": "'",
        "\u201c": '"',
        "\u201d": '"',
        "\u2015": '"',  # ―
        "\u2016": '"',  # ‖
    }
)

_GLUED_LETTER_NUMBER = re.compile(r"\b([A-Za-z]{1,16})(\d{1,8})\b")
_ROMAN_HEADING = re.compile(r"(?m)(^|\n)([ \t]*)([IVXLCDM]+)(\.)(?=\s|$)")

_ONES = (
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
)
_TENS = ("", "", "Twenty", "Thirty", "Forty", "Fifty")
_ROMAN_VALUES = (
    (50, "L"),
    (40, "XL"),
    (10, "X"),
    (9, "IX"),
    (5, "V"),
    (4, "IV"),
    (1, "I"),
)


def _canonical_roman(n: int) -> str:
    parts: list[str] = []
    for value, symbol in _ROMAN_VALUES:
        while n >= value:
            parts.append(symbol)
            n -= value
    return "".join(parts)


def _number_word(n: int) -> str | None:
    if n < 1 or n > 50:
        return None
    if n < 20:
        return _ONES[n]
    tens, ones = divmod(n, 10)
    if tens >= len(_TENS):
        return None
    if ones == 0:
        return _TENS[tens]
    return f"{_TENS[tens]}-{_ONES[ones].lower()}"


def fold_quotes(text: str) -> str:
    """ASCII apostrophes and quotes, so a curly don't stays one word."""
    return text.translate(_QUOTE_FOLD)


def split_letter_number_tokens(text: str) -> str:
    """CS183 → CS 183. A digit already separated from its letters stays."""
    return _GLUED_LETTER_NUMBER.sub(r"\1 \2", text)


def expand_roman_headings(text: str) -> str:
    """I. / II. / IV. at a line or paragraph start become One. / Two. / Four.

    A pronoun I in running text has no period, or it is not at the start
    of the line, so it is left alone.
    """

    def replace(match: re.Match[str]) -> str:
        token = match.group(3)
        if token != _canonical_roman_or_none(token):
            return match.group(0)
        # _canonical_roman_or_none returns the token when it is a real outline
        # numeral. Recompute the value from that canonical form.
        word = _word_for_roman(token)
        if word is None:
            return match.group(0)
        return f"{match.group(1)}{match.group(2)}{word}{match.group(4)}"

    return _ROMAN_HEADING.sub(replace, text)


def _canonical_roman_or_none(token: str) -> str | None:
    # Parse, then require the canonical spelling so IIII and IC stay put.
    values = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}
    total = 0
    prev = 0
    for char in reversed(token):
        value = values.get(char)
        if value is None:
            return None
        if value < prev:
            total -= value
        else:
            total += value
            prev = value
    if total < 1 or total > 50 or _canonical_roman(total) != token:
        return None
    return token


def _word_for_roman(token: str) -> str | None:
    values = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}
    total = 0
    prev = 0
    for char in reversed(token):
        value = values[char]
        if value < prev:
            total -= value
        else:
            total += value
            prev = value
    return _number_word(total)


def prepare_kokoro_text(text: str) -> str:
    """Quotes, outline headings, then glued tokens. Whitespace collapses last.

    Roman detection needs the line breaks, so it runs before the collapse.
    """
    folded = fold_quotes(str(text))
    headed = expand_roman_headings(folded)
    split = split_letter_number_tokens(headed)
    return " ".join(split.split())


def install_pronunciations(g2p: object) -> None:
    """Write our table over misaki's golds. us_gold is already loaded.

    A G2P object without ``lexicon.golds`` is left alone (tests, and a
    future fallback that does not use misaki). Keys are stored lowercase
    and in the surface forms misaki looks up before it folds case.
    """
    lexicon = getattr(g2p, "lexicon", None)
    if lexicon is None:
        inner = getattr(g2p, "g2p", None)
        lexicon = getattr(inner, "lexicon", None)
    golds = getattr(lexicon, "golds", None)
    if not isinstance(golds, dict):
        return
    for word, ipa in PRONUNCIATIONS.items():
        key = word.lower()
        golds[key] = ipa
        golds[key[:1].upper() + key[1:]] = ipa
        golds[key.upper()] = ipa
