"""LoRA fine-tune of the slow AR on breath-free speech.

Only used when steering is not enough. Kept in its own module so the training
maths can be unit-tested on CPU with the tiny shapes the real model uses.

What is trained
---------------
The slow AR is a causal LM over one semantic token per 46.4 ms frame. Fine-tuning
it means teacher-forcing the *codec-encoded* target audio (the encoder gives the
semantic token for every frame) and minimising cross-entropy on the semantic
token at each target position. The fast AR, the codec and the text embeddings
are frozen: the failure mode we care about is the slow AR choosing a breathy
latent, and unfreezing the fast AR would let it paper over that.

Prompt layout matches `ArkttsModel._prepare_prompt` exactly:
    [ prefix(text) | reference codes | suffix(text) ] then the target frames.
`prefix`/`suffix` come from `ArkttsProcessor._prompt_segments`, so a trained
model sees the same string layout that inference uses.

Why LoRA and not a full fine-tune: a rank-16 adapter on the attention and MLP
projections is ~2-3% of the slow AR's weights, so 1-5 h of audio is enough, the
original weights stay byte-identical for rollback, and the adapter can be
strength-scaled at inference.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import torch
import torch.nn as nn

LORA_TARGETS = ("attention.wqkv", "attention.wo", "feed_forward.w1", "feed_forward.w2", "feed_forward.w3")


class LoRALinear(nn.Module):
    """y = W x + (alpha / r) * B(A x), with A ~ N(0, 1/r) and B = 0 at init."""

    def __init__(self, base: nn.Linear, rank: int = 16, alpha: float = 32.0, dropout: float = 0.0):
        super().__init__()
        self.base = base
        for p in self.base.parameters():
            p.requires_grad_(False)
        self.rank = int(rank)
        self.scale = float(alpha) / float(rank)
        self.lora_a = nn.Linear(base.in_features, rank, bias=False)
        self.lora_b = nn.Linear(rank, base.out_features, bias=False)
        nn.init.normal_(self.lora_a.weight, std=1.0 / max(1, rank))
        nn.init.zeros_(self.lora_b.weight)
        self.dropout = nn.Dropout(dropout) if dropout > 0 else nn.Identity()

    def forward(self, x):
        return self.base(x) + self.scale * self.lora_b(self.lora_a(self.dropout(x)))


def inject_lora(model, rank: int = 16, alpha: float = 32.0, targets: tuple[str, ...] = LORA_TARGETS) -> dict:
    """Replace matching `nn.Linear`s inside the slow AR's blocks with LoRALinear.

    Walks `model.layers` only: the fast AR lives in `model.fast_layers` and the
    codec is loaded separately, so neither is reachable from here. Everything is
    frozen first, so the LoRA factors are the only trainable tensors.
    """
    for p in model.parameters():
        p.requires_grad_(False)
    replaced = 0
    for layer in getattr(model, "layers", []):
        for name, module in list(layer.named_children()):
            if name in ("attention", "feed_forward"):
                for sub_name, sub in list(module.named_children()):
                    full = f"{name}.{sub_name}"
                    if full in targets and isinstance(sub, nn.Linear):
                        setattr(module, sub_name, LoRALinear(sub, rank=rank, alpha=alpha))
                        replaced += 1
    if replaced == 0:
        raise RuntimeError("no LoRA targets matched; check the block naming in this checkpoint")
    for module in model.modules():
        if isinstance(module, LoRALinear):
            module.lora_a.weight.requires_grad_(True)
            module.lora_b.weight.requires_grad_(True)
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    return dict(replaced_modules=replaced, rank=rank, alpha=alpha, trainable_params=trainable)


def lora_state_dict(model) -> dict:
    return {k: v.detach().cpu() for k, v in model.state_dict().items() if ".lora_" in k}


def merge_lora(model) -> None:
    """Fold every LoRALinear back into its base weight, in place.

    After this the model is a plain checkpoint again, which is what the export
    step saves; keeping the adapter separate is only useful during training.
    """
    for layer in getattr(model, "layers", []):
        for holder_name in ("attention", "feed_forward"):
            holder = getattr(layer, holder_name, None)
            if holder is None:
                continue
            for sub_name, sub in list(holder.named_children()):
                if isinstance(sub, LoRALinear):
                    delta = (sub.lora_b.weight @ sub.lora_a.weight) * sub.scale
                    sub.base.weight.data += delta.to(sub.base.weight.dtype)
                    setattr(holder, sub_name, sub.base)


# ------------------------------------------------------------------ data batch


@dataclass
class Example:
    input_ids: torch.Tensor  # [num_codebooks + 1, T]
    attention_mask: torch.Tensor  # [T]
    target_start: int  # first column that is a target frame
    target_len: int


def build_example(
    model,
    processor,
    target_codes: np.ndarray,
    target_text: str,
    reference_codes: np.ndarray,
    reference_text: str,
    prefix_only: bool = False,
) -> Example:
    """One teacher-forced training example in the layout `_prepare_prompt` builds.

    `target_codes` is [num_codebooks, T] from the codec encoder; the semantic
    row is `codes[0] + semantic_begin_id`, exactly as inference does it.
    """
    config = model.config
    prefix, suffix = processor._prompt_segments(target_text, reference_text, has_reference=True)
    prefix_ids = prefix.long()
    suffix_ids = suffix.long()
    semantic = torch.from_numpy(np.asarray(target_codes, dtype=np.int64)[0]) + config.semantic_begin_id
    values = torch.zeros(
        (config.num_codebooks + 1, prefix_ids.numel() + target_codes.shape[1] + suffix_ids.numel()),
        dtype=torch.long,
    )
    start = prefix_ids.numel()
    values[0, :start] = prefix_ids
    values[0, start: start + target_codes.shape[1]] = semantic
    values[0, start + target_codes.shape[1]:] = suffix_ids
    values[1:, start: start + target_codes.shape[1]] = torch.from_numpy(
        np.asarray(target_codes, dtype=np.int64)
    )
    mask = torch.ones(values.shape[1], dtype=torch.long)
    return Example(input_ids=values, attention_mask=mask, target_start=start, target_len=target_codes.shape[1])


def detach_generation_caches(model) -> int:
    """Clear the KV caches `generate()` leaves on the attention modules.

    `_setup_generation_caches` installs an `ArkttsKVCache` on every slow and fast
    attention layer and never removes it. A later training forward pass then hits
    "cache_position is required when KV cache is enabled". Clearing them is what
    makes training possible in the same process as an evaluation generation.
    """
    cleared = 0
    for layer in list(getattr(model, "layers", [])) + list(getattr(model, "fast_layers", [])):
        attention = getattr(layer, "attention", None)
        if attention is not None and getattr(attention, "kv_cache", None) is not None:
            attention.kv_cache = None
            cleared += 1
    return cleared


def semantic_loss(model, example: Example, max_length: int = 2048) -> torch.Tensor:
    """Cross-entropy on the semantic token at each target position.

    The model is causal, so the logits at column `t` predict column `t + 1`.
    The prompt columns are masked out of the loss: we only score the frames the
    audio actually occupies, which is what removes breaths without teaching the
    model anything about the prompt.
    """
    ids = example.input_ids[:, :max_length]
    mask = example.attention_mask[:max_length]
    out = model(input_ids=ids.unsqueeze(0), attention_mask=mask.unsqueeze(0))
    logits = out.logits[0]  # [T, vocab]
    lo = example.target_start - 1
    hi = min(example.target_start + example.target_len - 1, logits.shape[0] - 1)
    if hi <= lo:
        raise ValueError("empty target window")
    predicted = logits[lo:hi]
    target = ids[0, lo + 1: hi + 1]
    return nn.functional.cross_entropy(predicted.float(), target, reduction="mean")


def trainable_parameters(model):
    return [p for p in model.parameters() if p.requires_grad]
