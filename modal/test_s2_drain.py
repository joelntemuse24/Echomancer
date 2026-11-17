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


def test_run_drain_restores_when_containers_stay_up():
    mod = load(DRAIN, "drain_restore_wait")
    restored = []
    code = mod.run_drain(
        call_ids=["fc"],
        other_live_books=0,
        restore_max=20,
        cancel=lambda _id: "still_live",
        brake=lambda: None,
        wait_idle=lambda: 3,
        restore=lambda maxc: restored.append(maxc),
        recheck_other=lambda: 0,
    )
    assert code == 2
    assert restored == [20]


def test_run_drain_restores_when_brake_raises():
    mod = load(DRAIN, "drain_restore_raise")
    restored = []

    def boom():
        raise RuntimeError("brake exploded")

    with pytest.raises(RuntimeError, match="brake exploded"):
        mod.run_drain(
            call_ids=["fc"],
            other_live_books=0,
            restore_max=12,
            cancel=lambda _id: "still_live",
            brake=boom,
            wait_idle=lambda: 0,
            restore=lambda maxc: restored.append(maxc),
            recheck_other=lambda: 0,
        )
    assert restored == [12]


def test_run_drain_rechecks_other_books_before_braking():
    mod = load(DRAIN, "drain_recheck")
    braked = []
    code = mod.run_drain(
        call_ids=["fc"],
        other_live_books=0,
        restore_max=20,
        cancel=lambda _id: "still_live",
        brake=lambda: braked.append(1),
        wait_idle=lambda: 0,
        restore=lambda _max: None,
        recheck_other=lambda: 1,
    )
    assert braked == []
    assert code == 2


def test_a_missing_profile_keeps_the_worker_token(monkeypatch):
    mod = load(DRAIN, "drain_creds")
    monkeypatch.setenv("MODAL_TOKEN_ID", "id")
    monkeypatch.setenv("MODAL_TOKEN_SECRET", "secret")
    monkeypatch.setenv("MODAL_PROFILE", "ntemusejoel")
    mod.apply_worker_credentials(None)
    assert os.environ["MODAL_TOKEN_ID"] == "id"
    assert os.environ["MODAL_TOKEN_SECRET"] == "secret"
    mod.apply_worker_credentials("ntemusejoel")
    assert "MODAL_TOKEN_ID" not in os.environ
    assert "MODAL_TOKEN_SECRET" not in os.environ
    source = DRAIN.read_text()
    assert 'default=os.environ.get("MODAL_PROFILE")' not in source


def test_cover_script_restores_with_the_real_flag():
    text = COVER.read_text()
    assert "--scaledown-window" in text
    assert "unset MODAL_TOKEN_ID" in text
    assert "MODAL_PROFILE" in text
    assert "ntemusejoel" in text
    assert "|| true" not in text
    assert "--scaledown-window" in text
    assert "--scaledown 15" not in text
