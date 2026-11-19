"""One style row for every chunk length.

Kokoro's ``KPipeline.infer`` selects ``pack[len(phonemes) - 1]``. Stock
packs barely change above a hundred phonemes. A fine-tuned pack does, so
a section that splits into a long chunk and a short one changes timbre
in the middle.

``pin_style`` repeats one row into every index. Infer still indexes with
the phoneme count, and it still receives the same speed. The copy happens
once, when the voice is loaded, not once per chunk.
"""

from __future__ import annotations

import torch

from pack import GEORGE_VOICE_ID, SOWELL_VOICE_ID, PackError


def fixed_style_index(voice: str) -> int | None:
    """The pinned row for this voice, or None to keep Kokoro's length index.

    Drew's index lives next to the checkpoint path. Walter's is None until
    a measurement says the Sowell pack moves with length the way Drew's
    does. George is a stock Kokoro pack and stays indexed.
    """
    from drew import DREW_FIXED_STYLE_INDEX, DREW_VOICE_ID
    from pack import SOWELL_FIXED_STYLE_INDEX

    if voice == DREW_VOICE_ID:
        return DREW_FIXED_STYLE_INDEX
    if voice == SOWELL_VOICE_ID:
        return SOWELL_FIXED_STYLE_INDEX
    if voice == GEORGE_VOICE_ID:
        return None
    return None


def pin_style(pack: torch.Tensor, index: int | None) -> torch.Tensor:
    """A pack whose every row is ``pack[index]``. None returns ``pack`` itself.

    The returned tensor has the same shape and dtype. Indexing it with any
    phoneme length yields the same 256-d vector, which is what
    ``KPipeline.infer`` reads.
    """
    if index is None:
        return pack
    rows = int(pack.shape[0])
    if isinstance(index, bool) or not isinstance(index, int) or index < 0 or index >= rows:
        raise PackError(f"fixed style index {index} is outside 0..{rows - 1}")
    row = pack[index].detach().to(dtype=pack.dtype, device="cpu")
    return row.unsqueeze(0).expand(rows, *row.shape).contiguous()
