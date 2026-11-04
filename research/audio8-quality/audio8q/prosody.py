"""Chunking + joining strategies for long-form Audio8 narration (no Modal, no torch).

Passages are lists of paragraphs. Each chunker returns a list of dicts
{text, para, join} where `join` is the boundary type *after* the chunk:
'clause' (split inside a sentence at , ; :), 'sentence', 'turn' (next paragraph is a
dialogue turn), 'para' (next paragraph is narration), or 'end'.
"""
from __future__ import annotations

import re

import numpy as np

PASSAGES = {
    "pride": [
        "\"Why, my dear, you must know, Mrs. Long says that Netherfield is taken by a young man of large fortune from the north of England; that he came down on Monday in a chaise and four to see the place, and was so much delighted with it, that he agreed with Mr. Morris immediately; that he is to take possession before Michaelmas, and some of his servants are to be in the house by the end of next week.\"",
        "\"What is his name?\"",
        "\"Bingley.\"",
        "\"Is he married or single?\"",
        "\"Oh! Single, my dear, to be sure! A single man of large fortune; four or five thousand a year. What a fine thing for our girls!\"",
        "\"How so? How can it affect them?\"",
        "\"My dear Mr. Bennet,\" replied his wife, \"how can you be so tiresome! You must know that I am thinking of his marrying one of them.\"",
        "\"Is that his design in settling here?\"",
        "\"Design! Nonsense, how can you talk so! But it is very likely that he may fall in love with one of them, and therefore you must visit him as soon as he comes.\"",
    ],
    "walden": [
        "I went to the woods because I wished to live deliberately, to front only the essential facts of life, and see if I could not learn what it had to teach, and not, when I came to die, discover that I had not lived. I did not wish to live what was not life, living is so dear; nor did I wish to practise resignation, unless it was quite necessary.",
        "I wanted to live deep and suck out all the marrow of life, to live so sturdily and Spartan-like as to put to rout all that was not life, to cut a broad swath and shave close, to drive life into a corner, and reduce it to its lowest terms, and, if it proved to be mean, why then to get the whole and genuine meanness of it, and publish its meanness to the world; or if it were sublime, to know it by experience, and be able to give a true account of it in my next excursion.",
        "Still we live meanly, like ants; though the fable tells us that we were long ago changed into men. Our life is frittered away by detail. An honest man has hardly need to count more than his ten fingers, or in extreme cases he may add his ten toes, and lump the rest. Simplicity, simplicity, simplicity! I say, let your affairs be as two or three, and not a hundred or a thousand.",
    ],
}

PAUSE_MS = {"clause": 150, "sentence": 350, "turn": 450, "para": 700, "end": 0}
_ABBR = r"(?<!\bMr\.)(?<!\bMrs\.)(?<!\bDr\.)(?<!\bSt\.)"


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def sentences(par: str) -> list[str]:
    return [s for s in re.split(_ABBR + r"(?:(?<=[.!?])|(?<=[.!?][\"”]))\s+", clean(par)) if s]


def _split_long(s: str, limit: int) -> list[str]:
    """Split a too-long sentence at ; : first, then commas, into pieces <= limit."""
    for pat in (r"(?<=[;:])\s+", r"(?<=,)\s+"):
        parts = re.split(pat, s)
        if len(parts) == 1:
            continue
        out, cur = [], ""
        for p in parts:
            if cur and len(cur) + 1 + len(p) > limit:
                out.append(cur)
                cur = p
            else:
                cur = f"{cur} {p}".strip()
        out.append(cur)
        if all(len(o) <= limit for o in out):
            return out
        res = []
        for o in out:
            res.extend(_split_long(o, limit) if len(o) > limit and pat != r"(?<=,)\s+" else [o])
        return res
    return [s]


def _para_join(paras, i):
    if i == len(paras) - 1:
        return "end"
    return "turn" if paras[i + 1].lstrip().startswith(("\"", "“")) or paras[i].lstrip().startswith(("\"", "“")) else "para"


def chunk_whole(paras):
    return [dict(text=clean(p), para=i, join=_para_join(paras, i)) for i, p in enumerate(paras)]


def chunk_flat150(paras, limit=150, min_len=40):
    """The rootcause 'chunks' flow: whole passage as one string, <=150 chars."""
    text = clean(" ".join(paras))
    pieces = []
    for s in re.split(_ABBR + r"(?<=[.!?])\s+", text):
        pieces.extend([s] if len(s) <= limit else _split_long(s, limit))
    out = []
    for p in pieces:
        if out and len(out[-1]) < min_len and len(out[-1]) + 1 + len(p) <= limit:
            out[-1] = f"{out[-1]} {p}"
        else:
            out.append(p)
    return [dict(text=c, para=-1, join="flat") for c in out]


def chunk_natural(paras, limit=220, max_sents=2):
    """Pack 1-2 whole sentences per chunk (<=limit); split huge sentences at clauses."""
    out = []
    for i, p in enumerate(paras):
        cur, n = "", 0
        items = []
        for s in sentences(p):
            if len(s) > limit:
                if cur:
                    items.append((cur, "sentence")); cur, n = "", 0
                parts = _split_long(s, limit)
                items.extend((x, "clause") for x in parts[:-1])
                items.append((parts[-1], "sentence"))
                continue
            if cur and (n >= max_sents or len(cur) + 1 + len(s) > limit):
                items.append((cur, "sentence")); cur, n = "", 0
            cur = f"{cur} {s}".strip(); n += 1
        if cur:
            items.append((cur, "sentence"))
        items[-1] = (items[-1][0], _para_join(paras, i))
        out.extend(dict(text=t, para=i, join=j) for t, j in items)
    return out


# ------------------------------------------------------------------ joining


def _db(x):
    return 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-9)


def trim(y, sr, thr_db=-50.0, margin_s=0.03, frame_s=0.01):
    hop = int(sr * frame_s)
    n = len(y) // hop
    if n == 0:
        return y
    e = np.array([_db(y[k * hop:(k + 1) * hop]) for k in range(n)])
    on = np.where(e > thr_db)[0]
    if len(on) == 0:
        return y
    a = max(0, on[0] * hop - int(margin_s * sr))
    b = min(len(y), (on[-1] + 1) * hop + int(margin_s * sr))
    return y[a:b]


def speech_rms_db(y, sr):
    hop = int(sr * 0.02)
    fr = [y[k:k + hop] for k in range(0, len(y) - hop, hop)]
    e = np.array([_db(f) for f in fr]) if fr else np.array([_db(y)])
    top = e[e > e.max() - 25]
    return float(10 * np.log10(np.mean(10 ** (top / 10))))


def join_flat(chunks_audio, sr, gap_ms=300):
    out, joins = [], []
    pos = 0
    for k, a in enumerate(chunks_audio):
        out.append(a); pos += len(a)
        if k < len(chunks_audio) - 1:
            joins.append(dict(t=pos / sr, gap=gap_ms / 1000, kind="flat"))
            g = np.zeros(int(sr * gap_ms / 1000), np.float32); out.append(g); pos += len(g)
    return np.concatenate(out), joins


def join_natural(chunks_audio, chunks, sr, fade_ms=25, loud_match=True):
    """Trim edges, match per-chunk loudness to the median, fade 25 ms, pause by type."""
    trimmed = [trim(a, sr) for a in chunks_audio]
    if loud_match:
        lv = [speech_rms_db(a, sr) for a in trimmed]
        target = float(np.median(lv))
        trimmed = [a * (10 ** ((target - l) / 20)) for a, l in zip(trimmed, lv)]
    f = int(sr * fade_ms / 1000)
    ramp = np.linspace(0, 1, f, dtype=np.float32)
    out, joins, pos = [], [], 0
    for k, (a, c) in enumerate(zip(trimmed, chunks)):
        a = a.astype(np.float32).copy()
        if len(a) > 2 * f:
            a[:f] *= ramp; a[-f:] *= ramp[::-1]
        out.append(a); pos += len(a)
        if k < len(chunks) - 1:
            gap = PAUSE_MS[c["join"]] / 1000
            joins.append(dict(t=pos / sr, gap=gap, kind=c["join"]))
            g = np.zeros(int(sr * gap), np.float32); out.append(g); pos += len(g)
    y = np.concatenate(out)
    peak = np.abs(y).max()
    if peak > 0.98:
        y = y * (0.98 / peak)
    return y, joins
