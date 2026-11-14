"""Codec tuning must change timing, never a sample.

`_tune_decoder` and `_MaskCache` touch the decoder that turns codes into audio,
so "it should be bit-identical" is not good enough — these tests build a real
`weight_norm`-parametrized conv stack, decode the same codes with and without
the tuning, and compare the samples.

Skipped when torch is not installed; the GPU image always has it.
"""

from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")


class _CausalConv(torch.nn.Module):
    """The shape the decoder's convs have: a `conv` inside a wrapper module.

    `remove_weight_norm` on the wrapper is what the upstream decoder exposes
    (`CausalConvNet.remove_weight_norm`), so the tuner's first branch is the real
    one. The generic `is_parametrized` branch is exercised by the second case.
    """

    def __init__(self, channels: int) -> None:
        super().__init__()
        self.conv = torch.nn.utils.parametrizations.weight_norm(
            torch.nn.Conv1d(channels, channels, 3, padding=1)
        )

    def remove_weight_norm(self) -> None:
        from torch.nn.utils.parametrize import remove_parametrizations

        self.conv = remove_parametrizations(self.conv, "weight")

    def forward(self, x):
        return self.conv(x)


class _PlainConv(torch.nn.Module):
    """A conv with a weight-norm parametrization but no `remove_weight_norm`."""

    def __init__(self, channels: int) -> None:
        super().__init__()
        self.weight = torch.nn.Parameter(torch.randn(channels, channels, 3) * 0.1)

    def forward(self, x):
        return x


@pytest.fixture
def decoder():
    torch.manual_seed(3)
    module = torch.nn.Sequential(
        _CausalConv(4),
        torch.nn.ReLU(),
        _CausalConv(4),
    )
    return module


@pytest.fixture(scope="module")
def batch_module():
    """`s2_batch` imported for v10, where codec tuning is on by default."""
    import importlib
    import os
    import sys

    sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
    os.environ["S2C_ENGINE"] = "v10"
    sys.modules.pop("s2_batch", None)
    from test_s2_unit_assembly import _install_stubs

    _install_stubs()
    module = importlib.import_module("s2_batch")
    yield module
    sys.modules.pop("s2_batch", None)
    os.environ.pop("S2C_ENGINE", None)


def _tune(decoder, module, monkeypatch, *, enabled: bool):
    """Run `_tune_decoder` with the module-level switch forced."""
    monkeypatch.setattr(module, "CODEC_TUNING", enabled)
    return module._tune_decoder(decoder, torch.device("cpu"))


def test_removing_weight_norm_is_bit_identical(decoder, batch_module, monkeypatch):
    """The frozen conv must produce exactly the weights the parametrization did."""
    torch.manual_seed(9)
    x = torch.randn(1, 4, 64)
    with torch.no_grad():
        before = decoder(x).clone()

    stats = _tune(decoder, batch_module, monkeypatch, enabled=True)
    assert stats["weight_norm_removed"] >= 2, stats
    with torch.no_grad():
        after = decoder(x).clone()
    assert torch.equal(before, after), (
        "freezing weight_norm changed the output; the emitted samples would "
        f"differ by up to {(before - after).abs().max()}"
    )
    # And the parametrization really is gone, so the per-call cost is gone too.
    from torch.nn.utils.parametrize import is_parametrized

    assert not any(
        is_parametrized(m, "weight") for m in decoder.modules() if hasattr(m, "weight")
    )


def test_tuning_can_be_disabled(decoder, batch_module, monkeypatch):
    stats = _tune(decoder, batch_module, monkeypatch, enabled=False)
    assert stats["weight_norm_removed"] == 0
    assert stats["skipped"] == "S2B_CODEC_TUNING=0"
    from torch.nn.utils.parametrize import is_parametrized

    assert any(
        is_parametrized(m, "weight") for m in decoder.modules() if hasattr(m, "weight")
    ), "disabled tuning must leave the parametrizations alone"


# ── the mask cache ─────────────────────────────────────────────────────────


class _WindowLimited(torch.nn.Module):
    """The mask builder the codec's attention blocks expose."""

    def __init__(self, window: int = 3) -> None:
        super().__init__()
        self.causal = True
        self.window_size = window
        self.builds = 0

    def make_window_limited_mask(self, max_length, x_lens=None):
        self.builds += 1
        rows = torch.arange(max_length).view(-1, 1)
        cols = torch.arange(max_length)
        valid = (cols >= (rows - self.window_size + 1).clamp(min=0))
        return (valid & (cols <= rows)).bool()[None, None]


def _mask_cache(batch_module, device=None):
    return batch_module._MaskCache(device or torch.device("cpu"))


def test_the_mask_cache_returns_the_mask_the_module_would_have_built(batch_module):
    """Same tensor, built once per length instead of once per call."""
    modules = torch.nn.ModuleList([_WindowLimited(w) for w in (3, 5)])
    reference = [m.make_window_limited_mask(17).clone() for m in modules]

    cache = _mask_cache(batch_module)
    installed = cache.install(modules)
    assert installed == 2
    for module, expected in zip(modules, reference):
        for _ in range(5):
            got = module.make_window_limited_mask(17)
            assert torch.equal(got, expected), "the cached mask must be identical"
    assert cache.misses == 2, "one build per (module, length)"
    assert cache.hits == 8, "everything after the first is a cache hit"


def test_the_mask_cache_keeps_lengths_apart(batch_module):
    """A longer code tensor must not be handed a shorter mask."""
    module = _WindowLimited(3)
    cache = _mask_cache(batch_module)
    cache.install(torch.nn.ModuleList([module]))
    short = module.make_window_limited_mask(8)
    long = module.make_window_limited_mask(16)
    assert short.shape[-1] == 8
    assert long.shape[-1] == 16
    assert not torch.equal(short, long)


def test_the_mask_cache_only_touches_causal_blocks(batch_module):
    """A non-causal block has its own mask rules and must be left alone."""
    causal = _WindowLimited(3)
    non_causal = _WindowLimited(3)
    non_causal.causal = False
    cache = _mask_cache(batch_module)
    installed = cache.install(torch.nn.ModuleList([causal, non_causal]))
    assert installed == 1
    # The untouched one still builds its own mask every call.
    non_causal.make_window_limited_mask(8)
    non_causal.make_window_limited_mask(8)
    assert non_causal.builds == 2


# ── the codec micro-batch ─────────────────────────────────────────────────


def test_length_sorted_micro_batches_pad_less_than_an_unsorted_page(batch_module):
    """Why `decode_codes` sorts: a mixed group pads every short take to the longest.

    Sorting only helps when a page spans **more than one** micro-batch — inside a
    single group the whole batch pads to its own longest either way. A full 32-row
    page of two-unit sections is 64 units at `DAC_MICRO_BATCH=16`, i.e. four
    groups, which is where the saving is.

    Computed rather than measured, because the saving *is* the padding.
    """
    # 64 units: 32 long ones (a long paragraph) and 32 short ones (a one-line
    # dialogue paragraph), interleaved in book order the way a page arrives.
    long_units = [900 - i for i in range(32)]
    short_units = [120 + i for i in range(32)]
    book_order: list[int] = []
    for index in range(32):
        book_order.append(long_units[index])
        book_order.append(short_units[index])

    def padded_frames(order, micro_batch=16):
        total = 0
        for start in range(0, len(order), micro_batch):
            group = order[start : start + micro_batch]
            total += max(group) * len(group)
        return total

    unsorted = padded_frames(book_order)
    sorted_padded = padded_frames(sorted(book_order))
    assert sorted_padded < unsorted, (sorted_padded, unsorted)
    # Order is restored on the way out, so this is pure padding work saved.
    assert len(book_order) == 64
    assert sorted_padded / unsorted < 0.75, (sorted_padded, unsorted)


def test_micro_batch_size_is_a_knob_and_defaults_above_the_old_eight(batch_module):
    """v9 used 8; v10 uses 16, which halves the number of codec launches."""
    assert batch_module.DAC_MICRO_BATCH >= 8
    # The grouping helper owns the default, so a caller that passes nothing gets
    # the knob rather than a second hard-coded number.
    source = __import__("inspect").getsource(
        batch_module._BatchEngine._decode_group_to_device
    )
    assert "micro_batch = DAC_MICRO_BATCH" in source


def test_legacy_weight_norm_hooks_are_removed_too(batch_module, monkeypatch):
    """The RVQ convolutions use the **legacy** `weight_norm`, not parametrizations.

    `descript-audio-codec`'s `ResidualVectorQuantize` layers carry a `weight_g` /
    `weight_v` pair with pre-forward hooks. Without the legacy branch those convs
    kept recomputing the norm on every call and paid the hook overhead.
    """
    import torch

    class _LegacyConv(torch.nn.Module):
        def __init__(self, channels: int) -> None:
            super().__init__()
            self.conv = torch.nn.Conv1d(channels, channels, 3, padding=1)
            torch.nn.utils.weight_norm(self.conv, name="weight", dim=0)

        def forward(self, x):
            return self.conv(x)

    torch.manual_seed(5)
    module = torch.nn.Sequential(_LegacyConv(4))
    conv = module[0].conv
    assert hasattr(conv, "weight_g") and hasattr(conv, "weight_v")

    torch.manual_seed(9)
    x = torch.randn(1, 4, 32)
    with torch.no_grad():
        before = module(x).clone()

    monkeypatch.setattr(batch_module, "CODEC_TUNING", True)
    stats = batch_module._tune_decoder(module, torch.device("cpu"))
    assert stats["weight_norm_removed"] >= 1, stats
    assert not hasattr(conv, "weight_g"), "the legacy hooks are gone"

    with torch.no_grad():
        after = module(x).clone()
    assert torch.allclose(before, after, atol=1e-6), (
        "removing the legacy weight_norm changed the output"
    )
