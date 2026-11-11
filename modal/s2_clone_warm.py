"""Build and verify the clone service's GPU snapshot after a deploy.

Run this right after deploying, and keep running it until consecutive calls
*restore*. A customer book must never be the thing that builds a snapshot.

    # staging app (never touches production)
    S2C_APP_NAME=echomancer-s2-clone-staging \
      modal run modal/s2_clone_warm.py::cover --containers 3 --rounds 6 --streak 3

    # one RPC, allowed to compile to completion (what the worker kicks)
    modal run modal/s2_clone_warm.py::cover --containers 1 --rounds 1 --scaledown 0

Why not just call the endpoint: Modal's web proxy drops a request at ~542 s,
and a fresh GPU snapshot takes 8–16 min. The container is killed mid-compile, so
the snapshot never finishes and every later call repeats the same death. This
talks to the class over the client RPC, which has no proxy limit.

Books wait at most the restore budget (~150 s, hard ceiling 180 s) and then
leave. `cover` is the path that is allowed to sit through a compile. Judge a
restore by wall time (`placement_kind`), not by `boot=`: that label cannot
say "compiled", and a real restore often reports `unknown` (the process is
pid 2 both before and after). Modal's log line
`Restoring Function from memory snapshot` is the platform record.

What "warm" means now:

  1. One direct `status()` call builds the snapshot (a fresh deploy has none)
     and reports which build id and container answered.
  2. `--verify` then starts `--containers` independent containers, spaced past
     `scaledown_window`, and checks each one *restored* rather than compiled.
     Modal needs 2-3 snapshots per GPU type because it runs a handful of
     worker variants, so one restore does not prove coverage.
  3. `--synth` renders a real batch through the same path the HTTP endpoint
     uses, with a validated synthetic reference clip, and reports duration and
     truncation so a silent or clipped take fails here instead of in a book.

The reference clip is generated in-process (`s2_contract.warm_reference_wav`)
unless `--reference-audio` names a real file. A 0-byte clip is what killed the
October snapshot, so an empty file is rejected before it reaches the GPU.
"""

from __future__ import annotations

import base64
import json
import os
import pathlib
import subprocess
import statistics
import time
from concurrent.futures import ThreadPoolExecutor

import modal

from s2_contract import (
    COMPILE_WALL_S,
    RESTORE_WALL_S,
    WARM_REFERENCE_TEXT,
    ReferenceClipError,
    cover_placement_kind,
    count_app_containers,
    snapshot_log_verdict,
    task_id_for_container,
    ReferenceTextError,
    placement_kind,
    validate_reference_audio,
    validate_reference_text,
    warm_reference_wav,
)

#: How long one RPC may sit. Matches the service's S2C_INIT_TIMEOUT (1800 s):
#: the slow H100 host variant compiles in ~19 min, past the old 1200 s, so the
#: client gave up seconds before the snapshot landed. Books never use this;
#: their HTTP wait is the restore budget.
RPC_COMPILE_TIMEOUT_S = 1800

#: Longest a cover run waits for the previous round's containers to exit.
ZERO_WAIT_MAX_S = 900

# An app object is required to host `local_entrypoint`; nothing is deployed
# from this file. The worker lives in s2_clone_service.py.
app = modal.App("echomancer-s2-clone-warm")

#: Match the service's default, but allow a staging app to be warmed without
#: touching production: `S2C_APP_NAME=echomancer-s2-clone-staging modal run …`.
APP_NAME = os.environ.get("S2C_APP_NAME", "echomancer-s2-clone")
CLASS_NAME = "S2CloneWorker"

SAMPLE_TEXT = (
    "The river had not moved for three days. Elena stood at the window and "
    "watched the light change on the water."
)

#: Sections used for the batch acceptance check. Short on purpose: this proves
#: the contract and the codec, not the throughput of a real book.
BATCH_TEXTS = [
    "The river had not moved for three days.",
    "Elena stood at the window.",
    "She watched the light change on the water.",
    "Nobody in the village had seen it so still.",
]


def _reference(reference_audio: str) -> tuple[str, str, dict]:
    """Base64 clip + transcript, validated before it costs any GPU time."""
    if reference_audio:
        path = pathlib.Path(reference_audio)
        if not path.is_file():
            raise SystemExit(f"no such reference clip: {path}")
        audio = path.read_bytes()
        transcript = ""
        beside = path.with_suffix(path.suffix + ".txt")
        if beside.is_file():
            transcript = beside.read_text(encoding="utf-8")
    else:
        audio = warm_reference_wav()
        transcript = WARM_REFERENCE_TEXT
    try:
        stats = validate_reference_audio(audio)
        transcript = validate_reference_text(transcript)
    except (ReferenceClipError, ReferenceTextError) as err:
        raise SystemExit(f"reference clip is unusable: {err}") from err
    print(
        f"reference: {stats['format']} {stats['bytes']} bytes, "
        f"{stats['seconds']}s, rms {stats['rms']}, {len(transcript)} chars of transcript"
    )
    return base64.b64encode(audio).decode(), transcript, stats


def _build_snapshot(worker) -> dict:
    """One RPC call. On a fresh deploy this is the call that builds the
    snapshot; on a warm deploy it restores in seconds.

    Wall clock is the only honest restore number, and it is only available from
    outside: a restored container did not exist for most of its own boot, so it
    cannot report how long restoring took.
    """
    started = time.time()
    result = worker().status.remote()
    elapsed = time.time() - started
    result["wall_s"] = round(elapsed, 1)
    print(
        f"build={result.get('build')} container={result.get('container_id')} "
        f"boot={result.get('boot')} answered in {elapsed:.1f}s "
        f"(snapshot_age={result.get('snapshot_age_s')}s)"
    )
    if elapsed > 300:
        print(
            "  >5 min, so this call almost certainly built the snapshot.\n"
            "  `boot` only says `restored` when that is provable; Modal's own\n"
            "  log line is the authoritative record either way."
        )
    return result


def _verify_restores(worker, containers: int, scaledown: int) -> list[dict]:
    """Start `containers` distinct containers and time each one's boot.

    Spaced past `scaledown_window` so a warm container cannot answer the next
    call. `boot` is `restored` only when the host monotonic clock went
    backwards, which proves the image resumed on a different worker; otherwise
    it is `unknown`, because a container cannot prove it compiled and claiming
    so is what reported every real restore as a compile during staging. The
    wall clock printed beside it is the number to record.
    """
    results: list[dict] = []
    for i in range(max(1, containers)):
        if i:
            wait = max(5, scaledown + 5)
            print(f"  waiting {wait}s so the next call gets a fresh container …")
            time.sleep(wait)
        started = time.time()
        status = worker().status.remote()
        wall = time.time() - started
        boot = status.get("boot")
        kind = placement_kind(wall)
        print(
            f"  container {i}: wall={wall:.1f}s kind={kind} boot={boot or 'unknown'} "
            f"snapshot_age={status.get('snapshot_age_s')}s "
            f"id={status.get('container_id')} build={status.get('build')}"
        )
        print(
            "    kind is wall time. boot= is not the hard rule "
            "(unknown is normal on a restore; there is no compiled label)."
        )
        results.append({**status, "wall_s": round(wall, 1), "kind": kind})
    return results


def _synth_batch(worker, ref_b64: str, ref_text: str) -> dict:
    """One section through the same code the HTTP endpoint uses.

    Reaching the GPU through `.remote()` proves the model works. It does NOT
    prove the HTTP path works: staging had `.remote()` succeed while the sync
    FastAPI endpoint failed with CUBLAS_STATUS_ALLOC_FAILED, because the handler
    ran on a thread with no cuBLAS handle for the restored context. Run
    `scripts/s2/staging-smoke.mjs` for that path.
    """
    started = time.time()
    result = worker().synthesize_section.remote(
        BATCH_TEXTS[0], ref_b64, ref_text, "0.9,0.9"
    )
    single_s = time.time() - started
    print(
        f"  single section (RPC): {result['duration_s']}s audio in {result['call_s']}s "
        f"({result['realtime_x']}x), truncated_units={result['truncated_units']}, "
        f"boot={result.get('boot')} build={result.get('build')}"
    )
    if not result.get("audio_b64"):
        raise SystemExit("single-section render returned no audio")
    audio = base64.b64decode(result["audio_b64"])
    if len(audio) < 800:
        raise SystemExit(f"single-section render returned only {len(audio)} bytes")
    if result["duration_s"] <= 0:
        raise SystemExit("single-section render produced zero seconds of audio")
    result["wall_s"] = round(single_s, 1)
    return result


def main(
    reference_audio: str = "",
    verify: bool = True,
    containers: int = 1,
    synth: bool = True,
    scaledown: int = 300,
) -> None:
    ref_b64, ref_text, stats = _reference(reference_audio)
    worker = modal.Cls.from_name(APP_NAME, CLASS_NAME)

    print(f"\n== 1. snapshot ==")
    build = _build_snapshot(worker)

    if verify:
        print(f"\n== 2. restore on {max(1, containers)} worker variant(s) ==")
        restores = _verify_restores(worker, containers, scaledown)
        restored = [r for r in restores if r.get("kind") == "restore"]
        if len(restored) < len(restores):
            print(
                "\n  Not every call restored inside the book budget "
                f"({RESTORE_WALL_S:.0f}s). `boot=` is not that verdict.\n"
                "  A `kind=compile` row built a snapshot and must not be a book.\n"
                "  Keep going with `modal run modal/s2_clone_warm.py::cover`\n"
                "  (scale-to-zero between rounds) until consecutive restores land.\n"
                "  Modal's log line `Restoring Function from memory snapshot`\n"
                "  is the platform record when `boot=unknown`."
            )

    if synth:
        print("\n== 3. short synthesis through the clone path ==")
        _synth_batch(worker, ref_b64, ref_text)

    print(
        "\nDone. If step 1 took minutes this run created the snapshot. A book never\n"
        "does that: its HTTP wait is the restore budget (~150s, ceiling 180s).\n"
        "Keep covering variants with ::cover until consecutive wall-clock\n"
        "restores succeed. Next: scripts/s2/staging-smoke.mjs (see\n"
        "docs/s2-gpu-staging-runbook.md)."
    )


@app.local_entrypoint()
def warm(
    reference_audio: str = "",
    verify: bool = True,
    containers: int = 1,
    synth: bool = True,
    scaledown: int = 300,
) -> None:
    """Build the GPU snapshot after a deploy, then prove it restores."""
    print(f"warming {APP_NAME}.{CLASS_NAME} …")
    main(
        reference_audio=reference_audio,
        verify=verify,
        containers=containers,
        synth=synth,
        scaledown=scaledown,
    )


def _timed_status(worker, rpc_timeout: int) -> dict:
    """One `status()` over RPC. Wall time includes the cold boot."""
    started = time.time()
    try:
        status = worker().status.spawn().get(timeout=rpc_timeout)
    except Exception as err:  # a spawn that never lands is a real finding
        return {"error": str(err), "wall_s": round(time.time() - started, 1)}
    if not isinstance(status, dict):
        status = {"error": str(status)}
    status["wall_s"] = round(time.time() - started, 1)
    return status


def _fanout_status(worker, containers: int, rpc_timeout: int) -> list[dict]:
    """Start `containers` calls at once and time each one."""
    n = max(1, containers)
    with ThreadPoolExecutor(max_workers=n) as pool:
        return list(pool.map(lambda _i: _timed_status(worker, rpc_timeout), range(n)))


def _classify_row(status: dict, restore_s: float, compile_s: float) -> str:
    if status.get("error"):
        return "failed"
    return placement_kind(
        float(status.get("wall_s") or 0), restore_s=restore_s, compile_s=compile_s
    )


def _modal_cli(args: list[str], timeout: float) -> str | None:
    """Run the Modal CLI with a hard timeout. None when it is unavailable."""
    cli = os.environ.get("MODAL_CLI", "modal")
    try:
        out = subprocess.run(
            [cli, *args], capture_output=True, text=True, timeout=timeout, check=False
        )
    except (OSError, subprocess.TimeoutExpired) as err:
        print(f"  (modal {' '.join(args[:2])} unavailable: {err})")
        return None
    return out.stdout


def app_container_count(app_name: str = APP_NAME) -> int | None:
    raw = _modal_cli(["container", "list", "--json"], timeout=60)
    if raw is None:
        return None
    try:
        return count_app_containers(json.loads(raw or "[]"), app_name)
    except ValueError:
        return None


def wait_for_zero(app_name: str = APP_NAME, max_wait_s: float = ZERO_WAIT_MAX_S) -> bool:
    """Block until `app_name` has no containers, so the next call is cold.

    A fixed sleep is not enough: a container that is still up answers the next
    call warm and looks like a one-second restore.
    """
    deadline = time.time() + max_wait_s
    while True:
        n = app_container_count(app_name)
        print(f"  containers of {app_name}: {n if n is not None else 'unknown'}")
        if n == 0:
            return True
        if time.time() >= deadline:
            return False
        time.sleep(15)


def log_verdict(app_name: str, container_hex: str | None, since: str = "45m") -> tuple[str, str | None]:
    """(verdict, ta-id) from Modal's logs for one placement. Best effort."""
    if not container_hex:
        return "unverified", None
    app_log = _modal_cli(
        ["app", "logs", app_name, "--since", since, "--show-container-id",
         "--search", f"container={container_hex}", "--tail", "50"],
        timeout=90,
    )
    task = task_id_for_container(app_log or "", container_hex)
    if not task:
        return "unverified", None
    verdict = "unverified"
    for attempt in range(3):  # Modal's log index can lag the call by seconds
        if attempt:
            time.sleep(10)
        sys_log = _modal_cli(
            ["app", "logs", app_name, "--since", since, "--show-container-id",
             "--timestamps", "--source", "system", "--container", task, "--tail", "200"],
            timeout=90,
        )
        verdict = snapshot_log_verdict(sys_log or "", task)
        if verdict != "unverified":
            break
    return verdict, task


def cover_variants(
    worker,
    *,
    containers: int,
    rounds: int,
    streak: int,
    scaledown: int,
    restore_s: float,
    compile_s: float,
    rpc_timeout: int,
    verify_logs: bool = True,
) -> None:
    """Place containers until `streak` fresh containers in a row restore.

    Between rounds this waits until the app has zero containers (not a fixed
    sleep), so every placement is cold. A container id seen before, or one that
    was ready before the call started, is `reuse` and never counts. With
    `verify_logs`, a wall-clock restore only counts when Modal's system log has
    `Restoring Function from memory snapshot` for that container. A compile is
    success for *this* command (the snapshot sticks) and resets the streak.
    """
    print(
        "Books never build GPU snapshots. This RPC may: there is no HTTP proxy "
        f"limit, and each call may run for {rpc_timeout}s."
    )
    seen: set = set()
    streak_n = 0
    compiles = 0
    target = max(1, streak)
    total_rounds = max(1, rounds)
    for round_i in range(total_rounds):
        if round_i and scaledown > 0:
            print("\nscale-to-zero: waiting until the app has 0 containers …")
            if not wait_for_zero(APP_NAME, max(ZERO_WAIT_MAX_S, scaledown + 60)):
                print("  containers did not reach 0; stopping so nothing counts a warm reuse.")
                break
        print(f"\n== cover round {round_i + 1}/{total_rounds} ==")
        results = _fanout_status(worker, containers, rpc_timeout)
        for i, status in enumerate(results):
            wall = float(status.get("wall_s") or 0)
            kind = cover_placement_kind(status, seen, restore_s=restore_s, compile_s=compile_s)
            cid = status.get("container_id")
            task = None
            log_kind = "skipped"
            if verify_logs and kind in ("restore", "compile", "slow"):
                log_kind, task = log_verdict(APP_NAME, cid)
                if kind == "restore" and log_kind != "restore":
                    kind = "restore-unverified"
            print(
                f"  {i}: wall={wall:.1f}s kind={kind} log={log_kind} task={task} "
                f"since_ready={status.get('since_ready_s')} id={cid} {status.get('error') or ''}"
            )
            if cid:
                seen.add(cid)
            if kind == "compile":
                compiles += 1
                print("    this call built a snapshot. The next placement on that variant should restore.")
            if kind == "reuse":
                print("    warm reuse of a running container: proves nothing, not counted.")
                continue
            streak_n = streak_n + 1 if kind == "restore" else 0
            if streak_n >= target:
                print(
                    f"\n{target} consecutive restores on fresh containers "
                    f"(<= {restore_s:.0f}s{', confirmed in Modal logs' if verify_logs else ''})."
                )
                return
    print(
        f"\nrounds finished: {compiles} compile(s) completed over RPC, "
        f"restore streak {streak_n}/{target}."
    )
    if compiles:
        print("Re-run cover until the restore streak lands; do not send a book.")
    else:
        print("Restore streak not met. Re-run cover; do not use a customer book.")


@app.local_entrypoint()
def cover(
    containers: int = 3,
    rounds: int = 6,
    streak: int = 3,
    scaledown: int = 300,
    restore_s: float = RESTORE_WALL_S,
    compile_s: float = COMPILE_WALL_S,
    rpc_timeout: int = RPC_COMPILE_TIMEOUT_S,
    verify_logs: bool = True,
) -> None:
    """Cover worker variants until consecutive restores succeed.

    Scale to zero between rounds (`scaledown`, the service's scaledown_window).
    A single round with `--scaledown 0` is what the book worker kicks when a
    placement misses the restore budget: one RPC, allowed to compile.
    """
    print(f"covering {APP_NAME}.{CLASS_NAME} …")
    worker = modal.Cls.from_name(APP_NAME, CLASS_NAME)
    cover_variants(
        worker,
        containers=containers,
        rounds=rounds,
        streak=streak,
        scaledown=scaledown,
        restore_s=restore_s,
        compile_s=compile_s,
        rpc_timeout=rpc_timeout,
        verify_logs=verify_logs,
    )


@app.local_entrypoint()
def fanout(containers: int = 4, scaledown: int = 300) -> None:
    """Start four independent one-GPU containers and time each restore.

    This is the check that answers "do four lanes scale to four containers",
    and the one to run before raising `S2C_MAX_CONTAINERS` to 4. It does not
    use multi-GPU code: each call is its own one-GPU container.
    """
    worker = modal.Cls.from_name(APP_NAME, CLASS_NAME)
    started = time.time()
    results = _fanout_status(worker, containers, RPC_COMPILE_TIMEOUT_S)
    wall = time.time() - started
    ids = {r.get("container_id") for r in results if r.get("container_id")}
    walls = [r["wall_s"] for r in results if isinstance(r.get("wall_s"), (int, float))]
    kinds = [_classify_row(r, RESTORE_WALL_S, COMPILE_WALL_S) for r in results]
    print(f"{len(results)} calls in {wall:.0f}s; {len(ids)} distinct container(s)")
    for i, result in enumerate(results):
        print(f"  {i}: kind={kinds[i]} {result}")
    print(
        "  kind is wall time, not boot=. "
        f"restore <= {RESTORE_WALL_S:.0f}s, compile >= {COMPILE_WALL_S:.0f}s. "
        "For a streak across variants run ::cover."
    )
    if walls:
        print(
            f"  answer time: min {min(walls):.1f}s, "
            f"median {statistics.median(walls):.1f}s, max {max(walls):.1f}s"
        )
    if len(ids) < len(results):
        print(
            "  Fewer containers than calls: some calls shared one. Raise the "
            "concurrency or space the calls out; four lanes need four containers."
        )
    print(
        f"\n  scale-to-zero check: re-run after {scaledown}s idle; every "
        "container should be gone from the Modal dashboard's Containers tab.\n"
        "  Then time the FIRST cold HTTP call with staging-smoke.mjs — that wall\n"
        "  clock is the real restore duration."
    )
