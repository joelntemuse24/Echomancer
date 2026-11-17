"""Offline checks for the drain and the cover-script flags. No Modal network."""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DRAIN = ROOT / "scripts" / "s2" / "drain-stuck-calls.py"
AUTOSCALER = ROOT / "scripts" / "s2" / "set-live-autoscaler.py"
COVER = ROOT / "scripts" / "s2" / "post-deploy-cover.sh"


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_should_brake_only_when_this_book_is_alone():
    mod = load(DRAIN, "drain_stuck_calls")
    assert mod.should_brake(["still_live"], 0) is True
    assert mod.should_brake(["still_live"], 1) is False
    assert mod.should_brake(["terminal"], 0) is False


def test_restore_max_refuses_to_guess_one():
    mod = load(DRAIN, "drain_stuck_calls")
    assert mod.planned_restore_max(20) == 20
    with pytest.raises(SystemExit, match="guess"):
        mod.planned_restore_max(None)
    with pytest.raises(SystemExit, match="guess"):
        mod.planned_restore_max(0)


def test_not_found_stays_still_live():
    mod = load(DRAIN, "drain_stuck_calls")
    assert mod.interpret("NotFoundError: missing", "") == "still_live"
    assert mod.interpret("", "terminated") == "terminal"


def test_dry_run_does_not_import_modal(monkeypatch):
    monkeypatch.delenv("MODAL_TOKEN_ID", raising=False)
    monkeypatch.delenv("MODAL_TOKEN_SECRET", raising=False)
    completed = subprocess.run(
        [
            sys.executable,
            str(DRAIN),
            "--dry-run",
            "--call-id",
            "fc-1",
            "--other-live-books",
            "1",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0
    assert "dry-run: no Modal calls" in completed.stdout
    assert "no brake" in completed.stdout
    assert "max_containers=1" not in completed.stdout


def test_autoscaler_help_and_bad_flag():
    help_run = subprocess.run(
        [sys.executable, str(AUTOSCALER), "--help"],
        check=False,
        capture_output=True,
        text=True,
    )
    assert help_run.returncode == 0
    assert "--scaledown-window" in help_run.stdout
    bad = subprocess.run(
        [sys.executable, str(AUTOSCALER), "--scaledown", "15", "--max-containers", "20"],
        check=False,
        capture_output=True,
        text=True,
    )
    assert bad.returncode != 0


def test_print_max_from_env_does_not_guess(monkeypatch):
    monkeypatch.setenv("MODAL_S2_MAX_GPUS", "20")
    monkeypatch.delenv("S2C_RESTORE_MAX", raising=False)
    completed = subprocess.run(
        [sys.executable, str(AUTOSCALER), "--print-max", "--from-env", "--app", "echomancer-s2-clone"],
        check=False,
        capture_output=True,
        text=True,
        env={**os.environ, "MODAL_S2_MAX_GPUS": "20"},
    )
    assert completed.returncode == 0
    assert completed.stdout.strip() == "20"


def test_cover_script_restores_with_the_real_flag():
    text = COVER.read_text()
    assert "--scaledown-window" in text
    assert "unset MODAL_TOKEN_ID" in text
    assert "MODAL_PROFILE" in text
    assert "ntemusejoel" in text
    assert "|| true" not in text
    assert "--scaledown-window" in text
    assert "--scaledown 15" not in text
