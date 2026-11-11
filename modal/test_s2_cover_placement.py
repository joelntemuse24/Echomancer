"""Offline tests for cover placement honesty — no GPU, no Modal, no network.

A cover run once reported "restores" that were the same warm container
answering again. These pin the rules that stop that.
"""

from __future__ import annotations

import pathlib
import re

from s2_contract import (
    cover_placement_kind,
    count_app_containers,
    snapshot_log_verdict,
    task_id_for_container,
)


def test_repeated_container_id_is_reuse_never_restore():
    seen = {"63a5f9544e76"}
    status = {"container_id": "63a5f9544e76", "wall_s": 0.8, "since_ready_s": 0.1}
    assert cover_placement_kind(status, seen) == "reuse"


def test_container_ready_before_the_call_is_reuse_even_if_new_to_run():
    status = {"container_id": "aaaa", "wall_s": 1.2, "since_ready_s": 140.0}
    assert cover_placement_kind(status, set()) == "reuse"


def test_fresh_container_is_judged_by_wall_clock():
    assert cover_placement_kind({"container_id": "a", "wall_s": 55, "since_ready_s": 3}, set()) == "restore"
    assert cover_placement_kind({"container_id": "b", "wall_s": 1141, "since_ready_s": 30}, set()) == "compile"
    assert cover_placement_kind({"container_id": "c", "wall_s": 200, "since_ready_s": 1}, set()) == "slow"
    assert cover_placement_kind({"error": "timeout", "wall_s": 1800}, set()) == "failed"


def test_count_app_containers_filters_by_app():
    rows = [
        {"app_name": "echomancer-s2-clone"},
        {"app_name": "echomancer-s2-clone-staging"},
        {"app_name": "echomancer-s2-clone"},
        "junk",
    ]
    assert count_app_containers(rows, "echomancer-s2-clone") == 2
    assert count_app_containers([], "echomancer-s2-clone") == 0


APP_LOG = (
    "ta-01M76732V2NSFDKESFJDNEH7WR [S2C] container=0e83d45da5ee build=aa02 boot=unknown\n"
    "ta-01M765RCBF4Z76449J9WYGSHCR [S2C] container=63a5f9544e76 build=aa02 boot=unknown\n"
)


def test_task_id_maps_service_hex_to_modal_task():
    assert task_id_for_container(APP_LOG, "0e83d45da5ee") == "ta-01M76732V2NSFDKESFJDNEH7WR"
    assert task_id_for_container(APP_LOG, "ffffffffffff") is None
    assert task_id_for_container(APP_LOG, "") is None


def test_snapshot_log_verdict():
    task = "ta-01AAA"
    restore = f"2026-11-11 22:00:01+00:00 {task} Restoring Function from memory snapshot"
    create = f"2026-11-11 20:45:56+00:00 {task} Creating GPU memory snapshot for Function."
    other = "2026-11-11 22:00:01+00:00 ta-01BBB Restoring Function from memory snapshot"
    assert snapshot_log_verdict(restore, task) == "restore"
    assert snapshot_log_verdict(create, task) == "compile"
    assert snapshot_log_verdict(other, task) == "unverified"
    assert snapshot_log_verdict(restore, None) == "unverified"


def test_cover_rpc_timeout_covers_the_service_init_timeout():
    here = pathlib.Path(__file__).parent
    warm = (here / "s2_clone_warm.py").read_text()
    service = (here / "s2_clone_service.py").read_text()
    rpc = int(re.search(r"^RPC_COMPILE_TIMEOUT_S = (\d+)", warm, re.M).group(1))
    init = int(re.search(r'S2C_INIT_TIMEOUT", "(\d+)"', service).group(1))
    assert rpc >= init
    # a fixed sleep between rounds let a warm container answer the next call
    assert "wait_for_zero(" in warm
