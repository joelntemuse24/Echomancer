"""Offline checks for the drain and the cover-script flags. No Modal network."""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DRAIN = ROOT / "scripts" / "s2" / "drain-stuck-calls.py"
AUTOSCALER = ROOT / "scripts" / "s2" / "set-live-autoscaler.py"
COVER = ROOT / "scripts" / "s2" / "post-deploy-cover.sh"
MODAL_CRED_KEYS = ("MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "MODAL_PROFILE")


def child_env(**extra: str) -> dict[str, str]:
    """Subprocess env with live Modal auth removed.

    The conftest already strips these. This repeats the strip on the mapping
    the child inherits, including when a test passes its own ``env``.
    """
    env = {key: value for key, value in os.environ.items() if key not in MODAL_CRED_KEYS}
    env.update(extra)
    for key in MODAL_CRED_KEYS:
        env.pop(key, None)
        assert key not in env
    assert os.environ.get("MODAL_CONFIG_PATH")
    env["MODAL_CONFIG_PATH"] = os.environ["MODAL_CONFIG_PATH"]
    return env


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
        env=child_env(),
    )
    assert completed.returncode == 0
    assert "dry-run: no Modal calls" in completed.stdout
    assert "no brake" in completed.stdout
    assert "max_containers=1" not in completed.stdout


def test_script_parsers_do_not_abbreviate_flags():
    """Every argparse CLI under scripts/s2 disables prefix matching.

    ``modal/*.py`` has no ArgumentParser. A new one must set
    ``allow_abbrev=False`` too, which this scan enforces for both trees.
    """
    for root in (ROOT / "scripts" / "s2", ROOT / "modal"):
        for path in root.glob("*.py"):
            text = path.read_text()
            if "ArgumentParser(" not in text:
                continue
            assert "allow_abbrev=False" in text, path


def test_live_modal_credentials_are_stripped():
    """The suite, and any child it starts, must not see live Modal auth."""
    for key in MODAL_CRED_KEYS:
        assert key not in os.environ
    config = Path(os.environ["MODAL_CONFIG_PATH"])
    assert config.is_file()
    assert config.read_text() == ""
    child = child_env()
    for key in MODAL_CRED_KEYS:
        assert key not in child


def test_autoscaler_help_and_bad_flag():
    env = child_env()
    help_run = subprocess.run(
        [sys.executable, str(AUTOSCALER), "--help"],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )
    assert help_run.returncode == 0
    assert "--scaledown-window" in help_run.stdout
    bad = subprocess.run(
        [sys.executable, str(AUTOSCALER), "--not-a-flag"],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )
    assert bad.returncode != 0
    assert "unrecognized arguments" in bad.stderr
    assert "live autoscaler now" not in bad.stdout
    abbreviated = subprocess.run(
        [sys.executable, str(AUTOSCALER), "--scaledown", "15"],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )
    assert abbreviated.returncode != 0
    assert "unrecognized arguments" in abbreviated.stderr
    assert "live autoscaler now" not in abbreviated.stdout


def test_production_apply_above_one_exits_before_modal():
    """The spelled-out apply that the old abbreviation test performed."""
    refused = subprocess.run(
        [
            sys.executable,
            str(AUTOSCALER),
            "--max-containers",
            "20",
            "--scaledown-window",
            "15",
            "--app",
            "echomancer-s2-clone",
        ],
        check=False,
        capture_output=True,
        text=True,
        env=child_env(),
    )
    assert refused.returncode != 0
    assert "refusing max_containers=20" in refused.stderr
    assert "S2_ALLOW_PROD_CAP_ABOVE_1" in refused.stderr
    assert "live autoscaler now" not in refused.stdout


def test_print_max_from_env_does_not_guess(monkeypatch):
    monkeypatch.setenv("MODAL_S2_MAX_GPUS", "20")
    monkeypatch.delenv("S2C_RESTORE_MAX", raising=False)
    completed = subprocess.run(
        [sys.executable, str(AUTOSCALER), "--print-max", "--from-env", "--app", "echomancer-s2-clone"],
        check=False,
        capture_output=True,
        text=True,
        env=child_env(MODAL_S2_MAX_GPUS="20"),
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
    assert "resolve_modal_python" in text
    assert "python3 scripts" not in text
    assert "python3 -m modal" not in text
    assert "--clamp-restore" in text
    assert "S2_ALLOW_PROD_CAP_ABOVE_1" in text


def test_clamp_restore_cli_caps_production_without_calling_modal(monkeypatch):
    """--clamp-restore exits before Modal. Production cannot restore 20."""
    monkeypatch.delenv("S2_ALLOW_PROD_CAP_ABOVE_1", raising=False)
    base = child_env()
    base.pop("S2_ALLOW_PROD_CAP_ABOVE_1", None)
    locked = subprocess.run(
        [
            sys.executable,
            str(AUTOSCALER),
            "--clamp-restore",
            "20",
            "--app",
            "echomancer-s2-clone",
        ],
        check=False,
        capture_output=True,
        text=True,
        env=base,
    )
    assert locked.returncode == 0
    assert locked.stdout.strip() == "1"
    staging = subprocess.run(
        [
            sys.executable,
            str(AUTOSCALER),
            "--clamp-restore",
            "20",
            "--app",
            "echomancer-s2-clone-staging",
        ],
        check=False,
        capture_output=True,
        text=True,
        env=base,
    )
    assert staging.returncode == 0
    assert staging.stdout.strip() == "20"
    opened = subprocess.run(
        [
            sys.executable,
            str(AUTOSCALER),
            "--clamp-restore",
            "20",
            "--app",
            "echomancer-s2-clone",
        ],
        check=False,
        capture_output=True,
        text=True,
        env={**base, "S2_ALLOW_PROD_CAP_ABOVE_1": "1"},
    )
    assert opened.returncode == 0
    assert opened.stdout.strip() == "20"


def test_modal_python_uses_MODAL_PYTHON_or_a_detected_interpreter(tmp_path):
    good = tmp_path / "good"
    good.mkdir()
    py = good / "python3"
    py.write_text("#!/bin/sh\nexit 0\n")
    py.chmod(0o755)
    bad = tmp_path / "bad"
    bad.mkdir()
    missing = bad / "python3"
    missing.write_text("#!/bin/sh\nexit 1\n")
    missing.chmod(0o755)
    script = "source scripts/s2/modal-python.sh && resolve_modal_python"
    bash = shutil.which("bash") or "/bin/bash"
    env = child_env()
    env.pop("MODAL_PYTHON", None)
    found = subprocess.run(
        [bash, "-c", script],
        check=False,
        capture_output=True,
        text=True,
        cwd=ROOT,
        env={**env, "PATH": str(good)},
    )
    assert found.returncode == 0
    assert found.stdout.strip() == str(py)
    missed = subprocess.run(
        [bash, "-c", script],
        check=False,
        capture_output=True,
        text=True,
        cwd=ROOT,
        env={**env, "PATH": str(bad)},
    )
    assert missed.returncode != 0
    assert "No Python on PATH can import modal" in missed.stderr
    explicit = subprocess.run(
        [bash, "-c", script],
        check=False,
        capture_output=True,
        text=True,
        cwd=ROOT,
        env={**env, "PATH": str(bad), "MODAL_PYTHON": str(py)},
    )
    assert explicit.returncode == 0
    assert explicit.stdout.strip() == str(py)
    absent = subprocess.run(
        [bash, "-c", script],
        check=False,
        capture_output=True,
        text=True,
        cwd=ROOT,
        env={**env, "MODAL_PYTHON": str(tmp_path / "no-such-python")},
    )
    assert absent.returncode != 0
    assert "not an executable" in absent.stderr


