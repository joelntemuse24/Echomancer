"""Offline tests for S2 input-queue hygiene. No GPU, no Modal network."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from s2_input_queue import (
    assert_no_unfinished_inputs,
    cancel_candidates,
    default_list_command,
    is_unfinished,
    may_cancel_abandoned_call,
    parse_calls_json,
    refuse_if_unfinished,
    unfinished_inputs,
)


def test_terminal_success_is_not_unfinished():
    assert is_unfinished({"status": "success", "started_at": "2026-11-12T05:00:00Z"}) is False
    assert is_unfinished({"status": "SUCCESS"}) is False
    assert is_unfinished({"status": "1"}) is False
    assert is_unfinished({"status": "failure"}) is False
    assert is_unfinished({"status": "terminated"}) is False
    assert is_unfinished({"status": "timeout"}) is False
    assert is_unfinished({"status": "init_failure"}) is False


def test_pending_and_running_are_unfinished():
    assert is_unfinished({"status": "pending", "started_at": None}) is True
    assert is_unfinished({"status": "PENDING"}) is True
    assert is_unfinished({"status": "0"}) is True
    assert is_unfinished({"status": "running"}) is True
    assert is_unfinished({"status": "InputStatus.PENDING"}) is True


def test_refuse_if_unfinished_passes_on_empty_or_terminal_only():
    refuse_if_unfinished([])
    refuse_if_unfinished([{"status": "success", "function_call_id": "fc-ok"}])


def test_refuse_if_unfinished_stops_warm_on_stale_pending():
    with pytest.raises(SystemExit, match="refusing to start"):
        refuse_if_unfinished(
            [
                {
                    "function_call_id": "fc-stale",
                    "status": "pending",
                    "started_at": None,
                    "service_method_name": "synthesize_batch",
                }
            ]
        )


def test_assert_no_unfinished_inputs_uses_injected_lister():
    payload = json.dumps(
        [{"function_call_id": "fc-1", "status": "success", "started_at": "2026-11-12T05:00:00Z"}]
    )
    seen: list[list[str]] = []

    def runner(command: list[str]) -> str:
        seen.append(command)
        return payload

    rows = assert_no_unfinished_inputs("echomancer-s2-clone", runner=runner)
    assert len(rows) == 1
    assert seen[0] == default_list_command("echomancer-s2-clone")
    assert "--json" in seen[0]


def test_assert_no_unfinished_inputs_refuses_pending():
    payload = json.dumps(
        [
            {
                "function_call_id": "fc-stale",
                "status": "pending",
                "started_at": None,
            }
        ]
    )
    with pytest.raises(SystemExit, match="stale PENDING|unfinished FunctionCall"):
        assert_no_unfinished_inputs(
            "echomancer-s2-clone", runner=lambda _command: payload
        )


def test_may_cancel_only_unstarted_pending():
    pending = {"status": "pending", "started_at": None, "function_call_id": "fc-a"}
    started = {
        "status": "pending",
        "started_at": "2026-11-12T05:32:48Z",
        "container_id": "ta-compiling",
        "function_call_id": "fc-b",
    }
    success = {"status": "success", "started_at": "2026-11-12T05:44:48Z"}
    assert may_cancel_abandoned_call(pending) is True
    assert may_cancel_abandoned_call(started) is False
    assert may_cancel_abandoned_call(success) is False
    assert cancel_candidates([pending, started, success]) == [pending]


def test_parse_calls_json_accepts_array_and_empty():
    assert parse_calls_json("") == []
    rows = parse_calls_json('[{"status":"success"}]')
    assert rows[0]["status"] == "success"


def test_unfinished_count():
    rows = [
        {"status": "success"},
        {"status": "pending"},
        {"status": "failure"},
        {"status": "running"},
    ]
    leftover = unfinished_inputs(rows)
    assert len(leftover) == 2
    assert {r["status"] for r in leftover} == {"pending", "running"}


def test_check_script_is_a_thin_wrapper():
    script = Path(__file__).resolve().parent.parent / "scripts" / "s2" / "check-input-queue.py"
    assert script.is_file()
    source = script.read_text(encoding="utf-8")
    assert "from s2_input_queue import main" in source


def test_warm_and_probe_entrypoints_call_the_queue_guard():
    source = Path(__file__).resolve().parent.joinpath("s2_clone_warm.py").read_text(encoding="utf-8")
    assert "from s2_input_queue import assert_no_unfinished_inputs" in source
    assert source.count("_require_empty_input_queue()") >= 3
    # Never tell an operator to cancel mid-enter.
    assert "Never cancel a FunctionCall" in source
