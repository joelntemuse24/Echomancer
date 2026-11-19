"""Sentence-type F0 rules inside one Kokoro forward. No second model pass.

Variant G is the contour the owner picked in the 2026-11-19 blind A/B
(``G_rules_phrase``): phrase smoothing with accent kept at 0.7 and a 3
semitone declination, plus the sentence-type offsets measured on real
Andrew. The A/B used style row 200. Production Drew stays on row 300;
the row is chosen in ``drew.py`` and this module does not touch it.

The rules edit the F0 tensor the predictor just produced, then the same
forward hands that tensor to the decoder. Duration, noise, and the
decoder each run once. With no recipe, the caller does not install the
hooks, so the forward is the stock ``KPipeline.infer`` call.

Drew is the only voice that opts in. The HTTP server applies a recipe
only when the request body says ``prosody: "G"`` — the same flag that
moves the take-home cache key. A container environment variable cannot
turn it on for a request that omitted the field, because that request
was cached under the unruled key.
"""

from __future__ import annotations

import os
import re
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator, Mapping, Sequence

# F0 frames per second. Kokoro's alignment is 24000/300 = 80 Hz and the
# predictor upsamples F0 by 2, which is what the duration-to-frame map
# repeats.
FPS_F0 = 24000 / 300 * 2

# Cache suffix for this recipe. Changing any constant below is a different
# voice: bump the suffix in this file and in ``drew-voice.ts`` together.
PROSODY_G_CACHE_SUFFIX = "-prosodyG"

_WH = frozenset({"what", "who", "whom", "whose", "which", "where", "when", "why", "how"})
_WORD = re.compile(r"[A-Za-z']+")
# Same lookbehind the A/B used, plus an ellipsis so "Wait… Don't go?" is
# two sentences. A dot inside "3.14" has no following space, so it stays.
_SPLIT = re.compile(r"(?<=[.!?…])[\"”’]?\s+")
_TRAIL = re.compile(r"([.!?…])[\"”’]*\s*$")
# Character after a terminator in the phoneme string. Space and the quotes
# Kokoro leaves attached to punctuation.
_AFTER = set(" \"”’")
_ON = frozenset({"1", "true", "on", "yes"})


@dataclass(frozen=True)
class ProsodyRecipe:
    """One named contour. ``name`` is what the request body and the cache say."""

    name: str
    accent_k: float
    decl_st: float
    excl_short_st: float
    excl_long_st: float
    excl_range: float
    excl_short_chars: int
    q_rise_st: float
    q_win_s: float
    smooth_s: float
    accent_window_s: float
    min_voiced: int
    max_shift_st: float


# G, hardcoded. The A/B read ACCENT_K and DECL_ST from the environment
# (defaults 1 and 0, which are a different variant). Production must not:
# a stray shell variable would change the voice without moving the cache key.
PROSODY_G = ProsodyRecipe(
    name="G",
    accent_k=0.7,
    decl_st=3.0,
    excl_short_st=4.0,
    excl_long_st=1.5,
    excl_range=1.15,
    excl_short_chars=40,
    q_rise_st=7.0,
    q_win_s=0.55,
    smooth_s=0.06,
    accent_window_s=0.4,
    min_voiced=10,
    # G's own rise is 7 st and accent compression only pulls 30% of a peak
    # toward the phrase. A real accent under an octave stays inside this.
    # A two-octave step does not, which is the buzz/jump guard.
    max_shift_st=18.0,
)

_RECIPES = {"G": PROSODY_G}


@dataclass(frozen=True)
class LocalSentence:
    """One sentence's slice of this chunk's phoneme string.

    ``sent_offset`` / ``sent_len`` place the slice inside the whole
    sentence, so a sentence Kokoro split across a 510-phoneme boundary
    keeps one declination instead of restarting the slope. ``ends_here``
    is the slice that holds the terminator: the yes/no rise is only
    applied there, on the last ``q_win_s`` of voiced frames.
    """

    start: int
    end: int
    kind: str
    ends_here: bool
    sent_offset: int
    sent_len: int


def drew_prosody_enabled(env: Mapping[str, str] | None = None) -> bool:
    """True only for an explicit on-value. Unset, empty, and ``0`` are off."""
    source = os.environ if env is None else env
    return str(source.get("DREW_PROSODY_RULES", "")).strip().lower() in _ON


def resolve_prosody(voice: str, requested: str | None, env: Mapping[str, str] | None = None) -> ProsodyRecipe | None:
    """The recipe for this call, or None to leave the forward untouched.

    ``requested`` is the HTTP field. ``""`` forces the stock forward even
    when ``DREW_PROSODY_RULES`` is set, which is how a request that did not
    ask for G stays bit-identical. ``None`` is the CLI: it reads the env.
    Walter and George never take a recipe.
    """
    from drew import DREW_VOICE_ID

    if voice != DREW_VOICE_ID:
        return None
    if requested == "":
        return None
    if requested is None:
        return PROSODY_G if drew_prosody_enabled(env) else None
    recipe = _RECIPES.get(requested)
    if recipe is None:
        raise ValueError(f"unknown prosody {requested!r}")
    return recipe


def grapheme_sentences(text: str) -> list[tuple[str, str]]:
    """``(text, kind)`` in order. ``kind`` is stmt, excl, qyn, or qwh.

    The first word decides a question, and a leading quote is not a word.
    ``What's`` stays a yes/no question: the A/B matched the wh-list exactly,
    and ``what's`` is not in it. A sentence split across chunks still uses
    this first word, not the first word of the later chunk.
    """
    parts = [part for part in _SPLIT.split(text.strip()) if part.strip()]
    return [(part, _kind(part)) for part in parts]


def _kind(part: str) -> str:
    match = _TRAIL.search(part.strip())
    if match is None:
        return "stmt"
    punct = match.group(1)
    if punct == "!":
        return "excl"
    if punct == "?":
        first = (_WORD.findall(part)[:1] or [""])[0].lower()
        return "qwh" if first in _WH else "qyn"
    return "stmt"


def phoneme_bounds(phonemes: str) -> list[tuple[int, int, bool]]:
    """``(start, end, ended)`` in phoneme-character coordinates.

    A terminator ends the sentence when the next character is the end of
    the chunk, a space, or a quote. ``3.14`` stays one span. An open tail
    (``ended`` false) is a sentence Kokoro has not finished yet.
    """
    spans: list[tuple[int, int, bool]] = []
    start = 0
    length = len(phonemes)
    for index, char in enumerate(phonemes):
        if char not in ".!?…":
            continue
        if index + 1 != length and phonemes[index + 1] not in _AFTER:
            continue
        # A closing quote after the terminator is still this sentence.
        # Leaving it behind made `"Is it?"` grow a one-character tail.
        end = index + 1
        while end < length and phonemes[end] in '"”’':
            end += 1
        spans.append((start, end, True))
        start = end
    if start < length and phonemes[start:].strip():
        spans.append((start, length, False))
    return spans


def plan_chunks(chunks: Sequence[tuple[str, str]]) -> list[list[LocalSentence]]:
    """Sentence slices for each ``(graphemes, phonemes)`` chunk.

    Kinds come from the joined graphemes, in order, so a chunk that starts
    at "That I have?" still knows the sentence began with "What". Phoneme
    spans that end are one sentence; an open tail continues into the next
    chunk. Extra phoneme spans (a "Dr." the graphemes did not split the
    same way) are statements, which get phrase smoothing and no rise.
    """
    graphemes = " ".join(text.strip() for text, _phonemes in chunks if text.strip())
    kinds = [kind for _text, kind in grapheme_sentences(graphemes)]
    plans: list[list[LocalSentence]] = [[] for _ in chunks]
    groups: list[list[tuple[int, int, int]]] = []
    current: list[tuple[int, int, int]] = []
    for chunk_index, (_text, phonemes) in enumerate(chunks):
        for start, end, ended in phoneme_bounds(phonemes):
            if end <= start:
                continue
            current.append((chunk_index, start, end))
            if ended:
                groups.append(current)
                current = []
    if current:
        groups.append(current)
    for group_index, group in enumerate(groups):
        kind = kinds[group_index] if group_index < len(kinds) else "stmt"
        sent_len = max(1, sum(end - start for _chunk, start, end in group))
        offset = 0
        last = len(group) - 1
        for piece, (chunk_index, start, end) in enumerate(group):
            plans[chunk_index].append(
                LocalSentence(
                    start=start,
                    end=end,
                    kind=kind,
                    ends_here=piece == last,
                    sent_offset=offset,
                    sent_len=sent_len,
                )
            )
            offset += end - start
    return plans


def _median_smooth(segment, width: int):
    """Sliding median with the same edge pad as a centred even window.

    The window is 0.4 s, 64 frames, which is even. ``np.median`` averages
    the two middle samples. The vectorised windows match that loop.
    """
    import numpy as np

    width = max(3, int(width))
    pad = np.pad(segment, (width // 2, width - width // 2 - 1), mode="edge")
    windows = np.lib.stride_tricks.sliding_window_view(pad, width)
    return np.median(windows, axis=-1)


def _token_chars(phonemes: str, vocab) -> list[int]:
    """Phoneme index of each model token, with boundary tokens at the ends.

    Kokoro drops characters the vocab does not know and wraps the rest in
    a start and end token. The duration vector is one entry per those.
    """
    keep = [index for index, char in enumerate(phonemes) if vocab.get(char) is not None]
    return [-1, *keep, len(phonemes)]


def edit_f0(f0, pred_dur, vocab, phonemes: str, recipe: ProsodyRecipe, sentences: Sequence[LocalSentence]):
    """Return F0 with G applied. The original tensor is not written.

    Unvoiced frames (F0 <= 40 Hz, Kokoro's own unvoiced mark) stay as they
    were. A non-finite result, or a shift past ``max_shift_st``, cannot
    reach the decoder: the shift is clamped, and a non-finite contour is
    replaced with the predictor's own F0.
    """
    import numpy as np

    if not sentences:
        return f0
    contour, shape = _as_contour(f0)
    durations = _as_durations(pred_dur)
    if contour.size == 0 or durations.size == 0:
        return f0
    chars = _token_chars(phonemes, vocab)
    char_of = np.full(durations.shape[0], -1, dtype=np.int32)
    for token, char in enumerate(chars[: durations.shape[0]]):
        char_of[token] = char
    token_at_frame = np.repeat(np.arange(durations.shape[0]), durations)
    if token_at_frame.size == 0:
        return f0
    token_at_f0 = np.repeat(token_at_frame, 2)
    frame_count = contour.shape[0]
    if token_at_f0.size < frame_count:
        token_at_f0 = np.pad(token_at_f0, (0, frame_count - token_at_f0.size), constant_values=-1)
    else:
        token_at_f0 = token_at_f0[:frame_count]
    frame_char = np.full(frame_count, -1, dtype=np.int32)
    known = token_at_f0 >= 0
    frame_char[known] = char_of[token_at_f0[known]]

    off = np.zeros(frame_count, dtype=np.float64)
    scale = np.ones(frame_count, dtype=np.float64)
    voiced = contour > 40
    for sentence in sentences:
        frames = np.flatnonzero((frame_char >= sentence.start) & (frame_char < sentence.end))
        if frames.size == 0:
            continue
        if sentence.kind == "excl":
            shift = (
                recipe.excl_short_st
                if sentence.sent_len < recipe.excl_short_chars
                else recipe.excl_long_st
            )
            off[frames] += shift
            scale[frames] = recipe.excl_range
        elif sentence.kind == "qyn" and sentence.ends_here:
            voiced_frames = frames[voiced[frames]]
            if voiced_frames.size == 0:
                continue
            window = max(1, int(recipe.q_win_s * FPS_F0))
            tail = voiced_frames[-window:]
            off[tail] += np.linspace(0.0, recipe.q_rise_st, tail.size)
    kernel_n = max(1, int(recipe.smooth_s * FPS_F0))
    kernel = np.ones(kernel_n) / kernel_n
    off = np.convolve(off, kernel, mode="same")
    scale = np.convolve(scale, kernel, mode="same")

    log_f0 = np.log2(np.clip(contour.astype(np.float64), 1.0, None)) * 12.0
    centre = float(np.median(log_f0[voiced])) if bool(voiced.any()) else 0.0
    edited_log = log_f0.copy()
    if recipe.accent_k != 1.0 or recipe.decl_st:
        for sentence in sentences:
            frames = np.flatnonzero(
                (frame_char >= sentence.start) & (frame_char < sentence.end) & voiced
            )
            if frames.size < recipe.min_voiced:
                continue
            segment = log_f0[frames]
            smooth = _median_smooth(segment, int(recipe.accent_window_s * FPS_F0))
            start_u = sentence.sent_offset / sentence.sent_len
            end_u = (sentence.sent_offset + (sentence.end - sentence.start)) / sentence.sent_len
            position = np.linspace(start_u, end_u, frames.size)
            declination = recipe.decl_st / 2.0 - recipe.decl_st * position
            edited_log[frames] = smooth + recipe.accent_k * (segment - smooth) + declination
    edited_log = centre + (edited_log - centre) * scale + off
    if not bool(np.isfinite(edited_log).all()):
        return f0
    delta = np.clip(edited_log - log_f0, -recipe.max_shift_st, recipe.max_shift_st)
    edited_log = log_f0 + delta
    edited = np.where(voiced, np.power(2.0, edited_log / 12.0), contour.astype(np.float64))
    if not bool(np.isfinite(edited).all()):
        return f0
    return _from_contour(edited, f0, shape)


def _as_contour(f0):
    import numpy as np

    array = f0.detach().cpu().float().numpy()
    shape = tuple(array.shape)
    if array.ndim == 2 and array.shape[0] == 1:
        return np.array(array[0], dtype=np.float64, copy=True), shape
    if array.ndim == 1:
        return np.array(array, dtype=np.float64, copy=True), shape
    raise ValueError(f"F0 shape {shape} is not a single contour")


def _as_durations(pred_dur):
    import numpy as np

    array = pred_dur.detach().cpu().reshape(-1).numpy()
    return np.maximum(np.asarray(array, dtype=np.int64), 1)


def _from_contour(edited, f0, shape):
    import numpy as np
    import torch

    array = np.ascontiguousarray(edited, dtype=np.float32).reshape(shape)
    return torch.from_numpy(array).to(device=f0.device, dtype=f0.dtype)


@contextmanager
def prosody_hooks(model, phonemes: str, speed: float, recipe: ProsodyRecipe, sentences: Sequence[LocalSentence]) -> Iterator[None]:
    """Swap the predictor for one forward, then put the original methods back.

    ``duration_proj`` is an ``nn.Linear``. A forward hook reads its output
    and leaves that output unchanged, so the duration the decoder's
    alignment uses is the one the stock forward computed. The F0 edit runs
    on the tensor ``F0Ntrain`` already produced. Both are local to this call.
    """
    predictor = getattr(model, "predictor", None)
    if predictor is None or not hasattr(predictor, "duration_proj") or not hasattr(predictor, "F0Ntrain"):
        raise RuntimeError("prosody rules need the Kokoro predictor")
    original_duration = predictor.duration_proj
    original_f0 = predictor.F0Ntrain
    captured: dict = {}

    def _capture(output):
        import torch

        duration = torch.sigmoid(output).sum(axis=-1) / speed
        captured["pred_dur"] = torch.round(duration).clamp(min=1).long().squeeze()

    def f0_ntrain(aligned, style):
        f0, noise = original_f0(aligned, style)
        durations = captured.get("pred_dur")
        if durations is None:
            return f0, noise
        return edit_f0(f0, durations, model.vocab, phonemes, recipe, sentences), noise

    # duration_proj is an nn.Linear. Assigning a function there raises,
    # and the stock forward must still be the one that runs. A forward
    # hook sees its output and does not change it. A test double that is
    # not a module is wrapped by hand and put back.
    handle = None
    if hasattr(original_duration, "register_forward_hook"):
        handle = original_duration.register_forward_hook(
            lambda _module, _inputs, output: _capture(output)
        )
    else:
        def duration_proj(features):
            output = original_duration(features)
            _capture(output)
            return output

        predictor.duration_proj = duration_proj
    predictor.F0Ntrain = f0_ntrain
    try:
        yield
    finally:
        if handle is not None:
            handle.remove()
        else:
            predictor.duration_proj = original_duration
        predictor.F0Ntrain = original_f0
