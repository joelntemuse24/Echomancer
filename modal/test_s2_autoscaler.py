"""Offline tests for the live autoscaler brake. No Modal network."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "s2" / "set-live-autoscaler.py"


def load_script():
    spec = importlib.util.spec_from_file_location("set_live_autoscaler", SCRIPT)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_validate_allows_brake_and_live_caps():
    mod = load_script()
    assert mod.validate_autoscaler_values(0, 45) is None
    assert mod.validate_autoscaler_values(1, 45) is None
    assert mod.validate_autoscaler_values(64, 15) is None
    assert mod.validate_autoscaler_values(64, 30) is None
    assert mod.validate_autoscaler_values(-1, 15) is not None
    assert mod.validate_autoscaler_values(65, 15) is not None
    assert mod.validate_autoscaler_values(1, 14) is not None
    assert mod.validate_autoscaler_values(1, 61) is not None


def test_parse_brake_flag_sets_max_zero():
    mod = load_script()
    args = mod.parse_args(["--brake"])
    assert args.max_containers == 0
    assert args.brake is True
    assert args.scaledown_window == 15


def test_parse_max_containers_zero_is_brake():
    mod = load_script()
    args = mod.parse_args(["--max-containers", "0", "--scaledown-window", "45"])
    assert args.max_containers == 0
    assert args.brake is True


def test_parse_live_cap_unchanged():
    mod = load_script()
    args = mod.parse_args(["--max-containers", "1", "--scaledown-window", "45"])
    assert args.max_containers == 1
    assert args.brake is False


def test_brake_rejects_nonzero_cap():
    mod = load_script()
    with pytest.raises(SystemExit, match="cannot be combined"):
        mod.parse_args(["--brake", "--max-containers", "3"])


def test_missing_max_containers_still_required_without_brake():
    mod = load_script()
    with pytest.raises(SystemExit):
        mod.parse_args([])
