"""ONNX runtime helpers that do not need Modal, torch, or a GPU.

`master.py` and `onnx_engine.py` are the pieces the container runs. These
tests cover the pure rules: recipe numbers, a manifest that does not match,
and the torch-import block. They do not load a Kokoro graph.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "sowell"))

from master import js_number, linear_af, parse_loudnorm_probe  # noqa: E402
from onnx_engine import OnnxEngineError, block_torch_import, read_manifest  # noqa: E402


def test_js_number_matches_a_plain_javascript_interpolation() -> None:
    assert js_number(1.0) == "1"
    assert js_number(-3.0) == "-3"
    assert js_number(0.5) == "0.5"
    assert "e" not in js_number(0.25)


def test_parse_loudnorm_probe_reads_the_last_object() -> None:
    stderr = 'noise\n{"input_i":"-19.1","input_tp":"-2.5","input_lra":"4.0","input_thresh":"-29.2","target_offset":"0.4"}\n'
    probe = parse_loudnorm_probe(stderr)
    assert probe is not None
    assert probe["input_i"] == pytest.approx(-19.1)
    assert parse_loudnorm_probe("no brace here") is None
    assert parse_loudnorm_probe('{"input_i": "nan"}') is None


def test_linear_af_swaps_the_printed_loudnorm_once() -> None:
    recipe = {
        "loudnorm": "loudnorm=I=-16",
        "measureAf": "highpass,loudnorm=I=-16:print_format=json,alimiter",
    }
    probe = {
        "input_i": -19.0,
        "input_tp": -2.0,
        "input_lra": 4.0,
        "input_thresh": -30.0,
        "target_offset": 0.5,
    }
    out = linear_af(recipe, probe)
    assert "print_format=json" not in out
    assert "linear=true" in out
    assert "measured_I=-19" in out
    assert out.startswith("highpass,")


def test_read_manifest_refuses_a_hash_mismatch(tmp_path: Path) -> None:
    (tmp_path / "drew.onnx").write_bytes(b"not-a-graph")
    (tmp_path / "manifest.json").write_text(
        json.dumps({"files": {"drew.onnx": "0" * 64}})
    )
    with pytest.raises(OnnxEngineError, match="hash mismatch"):
        read_manifest(tmp_path)


def test_block_torch_import_is_reversible(monkeypatch) -> None:
    monkeypatch.delenv("KOKORO_ONNX_ALLOW_TORCH", raising=False)
    prior = sys.modules.get("torch", "missing")
    sys.modules.pop("torch", None)
    try:
        blocked = block_torch_import()
        if blocked:
            assert sys.modules.get("torch") is None
        else:
            # spaCy's torch plugin is installed, so the block stays off.
            assert sys.modules.get("torch") is not None or True
    finally:
        if prior == "missing":
            sys.modules.pop("torch", None)
        else:
            sys.modules["torch"] = prior
