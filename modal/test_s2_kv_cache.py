"""The KV cache is not 0.02 GB, and the arithmetic should say so.

The figure published with PR 324 counted
`BATCH x layers x seq_len x 2 (k+v) x 2 B` and stopped there — about 0.019 GB —
leaving out the `kv_heads x head_dim` factor that a KV cache is *per head*. The
real number at this model's shape is about **18 GiB**.

It is still not what dominates a ~70 GB snapshot (the weights and the captured
CUDA-graph buffers are), but quoting 0.02 GB made the cache look free and sent
the size investigation at the weights alone. Keeping the arithmetic in a pure
function means the next model supplies its own config instead of a copied
constant.
"""

from __future__ import annotations

import importlib
import sys

import pytest

MODAL_DIR = __import__("pathlib").Path(__file__).parent


@pytest.fixture(scope="module")
def contract():
    sys.path.insert(0, str(MODAL_DIR))
    sys.modules.pop("s2_contract", None)
    module = importlib.import_module("s2_contract")
    yield module
    sys.path.remove(str(MODAL_DIR))
    sys.modules.pop("s2_contract", None)


def test_the_production_shape_is_about_18_gib(contract):
    """Three orders of magnitude above the 0.02 GB that was published."""
    gb = contract.kv_cache_gb()
    assert 15 < gb < 22, f"expected ~18 GiB at the S2-Pro shape, got {gb}"


def test_the_head_factor_is_what_was_missing(contract):
    """A head-less product gives 0.0176 GiB — the wrong figure, exactly."""
    headless = (
        contract.S2_PRO_KV_SHAPE["batch"]
        * contract.S2_PRO_KV_SHAPE["layers"]
        * contract.S2_PRO_KV_SHAPE["seq_len"]
        * 2  # k and v
        * contract.S2_PRO_KV_SHAPE["dtype_bytes"]
    )
    headless_gib = headless / 1024**3
    # The published 0.02 GB is this number; the real one is this times
    # kv_heads*head_dim.
    assert round(headless_gib, 2) == 0.02
    factor = contract.S2_PRO_KV_SHAPE["kv_heads"] * contract.S2_PRO_KV_SHAPE["head_dim"]
    assert factor == 1024
    assert round(headless_gib * factor, 2) == contract.kv_cache_gb()


def test_it_scales_linearly_in_every_dimension(contract):
    base = contract.kv_cache_bytes(
        batch=1, layers=1, kv_heads=1, head_dim=1, seq_len=1, dtype_bytes=2
    )
    assert base == 4  # one key + one value, two bytes each
    assert contract.kv_cache_bytes(
        batch=4, layers=1, kv_heads=1, head_dim=1, seq_len=1, dtype_bytes=2
    ) == base * 4
    assert contract.kv_cache_bytes(
        batch=1, layers=3, kv_heads=1, head_dim=1, seq_len=1, dtype_bytes=2
    ) == base * 3
    assert contract.kv_cache_bytes(
        batch=1, layers=1, kv_heads=5, head_dim=1, seq_len=1, dtype_bytes=2
    ) == base * 5
    assert contract.kv_cache_bytes(
        batch=1, layers=1, kv_heads=1, head_dim=7, seq_len=1, dtype_bytes=2
    ) == base * 7
    assert contract.kv_cache_bytes(
        batch=1, layers=1, kv_heads=1, head_dim=1, seq_len=9, dtype_bytes=2
    ) == base * 9


def test_k_and_v_are_both_counted(contract):
    """Forgetting the 2 here is the same class of error as forgetting the heads."""
    one = contract.kv_cache_bytes(
        batch=1, layers=1, kv_heads=1, head_dim=1, seq_len=1, dtype_bytes=1
    )
    assert one == 2


@pytest.mark.parametrize(
    "field,value",
    [
        ("batch", 0),
        ("layers", -1),
        ("kv_heads", 0),
        ("head_dim", 0),
        ("seq_len", 0),
        ("dtype_bytes", 0),
    ],
)
def test_a_nonsense_dimension_raises_rather_than_returning_zero(contract, field, value):
    shape = {
        "batch": 1,
        "layers": 1,
        "kv_heads": 1,
        "head_dim": 1,
        "seq_len": 1,
        "dtype_bytes": 2,
    }
    shape[field] = value
    with pytest.raises(ValueError):
        contract.kv_cache_bytes(**shape)


def test_a_bool_is_not_an_int(contract):
    """`True` would otherwise read as 1 and silently half a dimension."""
    with pytest.raises(ValueError):
        contract.kv_cache_bytes(
            batch=True, layers=1, kv_heads=1, head_dim=1, seq_len=1, dtype_bytes=2
        )


def test_a_smaller_shape_can_be_passed(contract):
    """A future model supplies its own config instead of a copied constant."""
    # The override replaces only the named field: `seq_len` keeps its rounded
    # 4096+8 default, which is what the engine actually allocates.
    assert contract.S2_PRO_KV_SHAPE["seq_len"] == 4104
    b = contract.kv_cache_bytes(**{**contract.S2_PRO_KV_SHAPE, "batch": 8})
    assert b == 8 * 36 * 4104 * 8 * 128 * 2 * 2
    assert contract.kv_cache_gb(batch=8) == round(b / 1024**3, 2)
    assert contract.kv_cache_gb(batch=8) < contract.kv_cache_gb(batch=32)
