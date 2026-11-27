"""Build and verify the clone service's GPU snapshot after a deploy.

Run this right after deploying, and keep running it until consecutive calls
*restore*. A customer book must never be the thing that builds a snapshot.

    # post-deploy, one container at a time (max_containers stays 1)
    bash scripts/s2/post-deploy-cover.sh
    # or: modal run modal/s2_clone_warm.py::restore_check

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

Never cancel a FunctionCall or `modal container stop` while enter/compile is
running: leftovers stay PENDING and are served after the next enter, which
interrupts snapshot publish, and container stop reschedules the input onto a
new compile. If you must stop new placements, apply the autoscaler brake
(`python3 scripts/s2/set-live-autoscaler.py --brake`) and let the compile
finish. This script refuses to start when the input queue still has PENDING
or unfinished FunctionCalls.

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
import os
import pathlib
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import modal

from s2_contract import (
    COMPILE_WALL_S,
    RESTORE_WALL_S,
    WARM_REFERENCE_TEXT,
    ReferenceClipError,
    ReferenceTextError,
    cold_restore_counts,
    compile_rpc_timeout_s,
    deploy_identity,
    fresh_gap_s,
    placement_kind,
    run_restore_check,
    validate_reference_audio,
    validate_reference_text,
    warm_reference_wav,
)
from s2_input_queue import assert_no_unfinished_inputs

#: How long one RPC may sit. A measured cold compile is 1290–1350s, so a
#: fixed 1200s get() returned before graphs existed and cover printed
#: graphs=missing. The budget is the init timeout and that measurement,
#: plus margin, and it stays under the class timeout. Books never use this.
RPC_COMPILE_TIMEOUT_S = compile_rpc_timeout_s()

# An app object is required to host `local_entrypoint`; nothing is deployed
# from this file. The worker lives in s2_clone_service.py.
app = modal.App("echomancer-s2-clone-warm")

#: Which app to warm. `s2_contract.resolve_app_name` is the same rule the service
#: and `check-input-queue.py` use, so a warm cannot land on a different app from
#: the one that was just deployed — and production needs `S2C_ALLOW_PRODUCTION=1`
#: to be named, because warming is not harmless: it can start a compile, and the
#: deploy that precedes it already invalidated that app's snapshots.
_IDENTITY = deploy_identity(os.environ)
APP_NAME = _IDENTITY["S2C_APP_NAME"]
CLASS_NAME = "S2CloneWorker"


def _require_empty_input_queue() -> None:
    """Refuse to start if leftover PENDING or unfinished FunctionCalls exist.

    Never cancel or container-stop a live enter/compile from this script. If
    you must stop *new* placements, apply the autoscaler brake
    (`scripts/s2/set-live-autoscaler.py --brake`) and let the compile finish.
    See docs/s2-gpu-staging-runbook.md (safe draining).
    """
    print(
        "checking the input queue for stale PENDING or unfinished FunctionCalls …"
    )
    rows = assert_no_unfinished_inputs(APP_NAME, CLASS_NAME)
    print(f"  queue is empty ({len(rows)} recent calls, all terminal).")


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
    _require_empty_input_queue()
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
        "Post-deploy proof is one cold restore: scripts/s2/post-deploy-cover.sh\n"
        "(::restore_check, one container, max_containers stays 1).\n"
        "Next: scripts/s2/staging-smoke.mjs (see docs/s2-gpu-staging-runbook.md)."
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
    # Queue check happens inside main() before any RPC.
    main(
        reference_audio=reference_audio,
        verify=verify,
        containers=containers,
        synth=synth,
        scaledown=scaledown,
    )


def _is_wait_timeout(err: BaseException) -> bool:
    name = type(err).__name__.lower()
    text = str(err).lower()
    return "timeout" in name or "timeout" in text


def _await_handle(handle, rpc_timeout: int, *, poll_s: int = 60):
    """Poll one spawned call until it returns or the compile budget ends.

    A single ``get(timeout=1200)`` raised while the container was still
    compiling. That exception has no ``graphs`` field, so cover reported
    ``graphs=missing``. A slice that times out is the same call, still
    running. The handle is not cancelled: cancelling a compile drops the
    snapshot this round is waiting to publish.
    """
    deadline = time.time() + max(1, int(rpc_timeout))
    last: BaseException | None = None
    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            return None, last or TimeoutError(
                f"status still running after {rpc_timeout}s"
            )
        slice_s = max(1, min(int(poll_s), int(remaining)))
        try:
            return handle.get(timeout=slice_s), None
        except Exception as err:
            last = err
            if not _is_wait_timeout(err):
                return None, err
            print(
                f"  status still running; {int(remaining)}s left "
                f"in the {rpc_timeout}s compile budget",
                flush=True,
            )


def _timed_status(worker, rpc_timeout: int) -> dict:
    """One `status()` over RPC. Wall time includes the cold boot."""
    started = time.time()
    try:
        handle = worker().status.spawn()
    except Exception as err:
        return {"error": str(err), "wall_s": round(time.time() - started, 1)}
    status, err = _await_handle(handle, rpc_timeout)
    if err is not None:
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


def _same_containers(results: list[dict], seen: set[str]) -> bool:
    """True when every id in this round was already used by an earlier round."""
    ids = [str(row.get("container_id") or "") for row in results]
    present = [cid for cid in ids if cid]
    if not present:
        return False
    return all(cid in seen for cid in present)


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
) -> bool:
    """Place containers until `streak` calls in a row restore by wall clock.

    Between rounds the previous containers are given `scaledown` seconds to
    exit, so the next fan-out can land on a different worker variant. A compile
    (wall >= compile_s) is success for *this* command — the snapshot sticks —
    and it resets the restore streak. A book never runs this.
    """
    print(
        "Books never build GPU snapshots. This RPC may: there is no HTTP proxy "
        f"limit, and each call may run for {rpc_timeout}s."
    )
    print(
        "Judge restores by wall time, not boot=. boot=unknown is normal on a "
        "real restore. Modal's log line 'Restoring Function from memory "
        "snapshot' is the platform record."
    )
    streak_n = 0
    compiles = 0
    seen: set[str] = set()
    target = max(1, streak)
    total_rounds = max(1, rounds)
    for round_i in range(total_rounds):
        if round_i and scaledown > 0:
            wait = fresh_gap_s(scaledown)
            print(f"\nscale-to-zero: waiting {wait}s so the next placement is a new container …")
            time.sleep(wait)
        print(f"\n== cover round {round_i + 1}/{total_rounds} ==")
        results = _fanout_status(worker, containers, rpc_timeout)
        if round_i and seen and _same_containers(results, seen) and scaledown > 0:
            wait = fresh_gap_s(scaledown)
            print(
                f"round answered from a container this cover already used; "
                f"waiting {wait}s for it to exit, then placing again"
            )
            time.sleep(wait)
            results = _fanout_status(worker, containers, rpc_timeout)
        for i, status in enumerate(results):
            wall = float(status.get("wall_s") or 0)
            kind = _classify_row(status, restore_s, compile_s)
            graphs = status.get("graphs") or ""
            print(
                f"  {i}: wall={wall:.1f}s kind={kind} boot={status.get('boot')} "
                f"graphs={graphs or 'missing'} "
                f"id={status.get('container_id')} {status.get('error') or ''}"
            )
            fresh = cold_restore_counts(status, seen)
            if kind == "restore" and fresh == "same-container":
                print(
                    f"    container {status.get('container_id')} already served "
                    "this cover; not a cold restore"
                )
                kind = "failed"
            elif kind == "restore" and fresh != "ok":
                print(f"    graphs={graphs} is not a captured graph; streak does not count")
                kind = "failed"
            cid = str(status.get("container_id") or "")
            if cid:
                seen.add(cid)
            if kind == "compile":
                compiles += 1
                print(
                    "    this call built a snapshot (wall time). "
                    "The next placement on that variant should restore."
                )
            if kind == "restore":
                streak_n += 1
            else:
                streak_n = 0
            if streak_n >= target:
                print(
                    f"\n{target} consecutive restores by wall clock "
                    f"(<= {restore_s:.0f}s). Variant coverage is in place.\n"
                    "Books still must not be the thing that compiles."
                )
                return True
    print(
        f"\nrounds finished: {compiles} compile(s) completed over RPC, "
        f"restore streak {streak_n}/{target}."
    )
    if compiles:
        print(
            "Those compiles were off the book path. Re-run cover after "
            "scale-to-zero until the restore streak lands; do not send a book."
        )
    else:
        print(
            "No compile finished and the restore streak was not met. "
            "Re-run cover. Do not use a customer book to build the snapshot."
        )
    return False


@app.local_entrypoint()
def cover(
    containers: int = 3,
    rounds: int = 6,
    streak: int = 3,
    scaledown: int = 300,
    restore_s: float = RESTORE_WALL_S,
    compile_s: float = COMPILE_WALL_S,
    rpc_timeout: int = RPC_COMPILE_TIMEOUT_S,
) -> None:
    """Cover worker variants until consecutive restores succeed.

    Scale to zero between rounds (`scaledown`, the service's scaledown_window).
    A single round with `--scaledown 0` is what the book worker kicks when a
    placement misses the restore budget: one RPC, allowed to compile.
    """
    print(f"covering {APP_NAME}.{CLASS_NAME} …")
    _require_empty_input_queue()
    worker = modal.Cls.from_name(APP_NAME, CLASS_NAME)
    met = False
    try:
        met = cover_variants(
            worker,
            containers=containers,
            rounds=rounds,
            streak=streak,
            scaledown=scaledown,
            restore_s=restore_s,
            compile_s=compile_s,
            rpc_timeout=rpc_timeout,
        )
    finally:
        print("min_containers stays 0. The wrapper restores the autoscaler.")
    if not met:
        sys.exit(1)


@app.local_entrypoint()
def restore_check(
    scaledown: int = 15,
    restore_s: float = RESTORE_WALL_S,
    compile_s: float = COMPILE_WALL_S,
    rpc_timeout: int = RPC_COMPILE_TIMEOUT_S,
) -> None:
    """One cold restore, compatible with ``max_containers=1``.

    Places a single ``status()`` call. If that call compiles (a fresh deploy
    has no memory snapshot; the volume cache is what makes the compile short)
    this waits out scale-to-zero and places exactly one more call, which must
    restore and report captured graphs. It does not fan out and it does not
    loop. ``::cover`` remains for an operator who still wants to prebuild
    several worker variants.
    """
    print(
        f"restore-check {APP_NAME}.{CLASS_NAME}: one container at a time. "
        "max_containers stays 1."
    )
    _require_empty_input_queue()
    worker = modal.Cls.from_name(APP_NAME, CLASS_NAME)

    def place() -> dict:
        return _timed_status(worker, rpc_timeout)

    ok = False
    try:
        ok = run_restore_check(
            place,
            scaledown=scaledown,
            restore_s=restore_s,
            compile_s=compile_s,
        )
    finally:
        print("min_containers stays 0. The wrapper restores the autoscaler.")
    if not ok:
        sys.exit(1)


@app.local_entrypoint()
def fanout(containers: int = 4, scaledown: int = 300) -> None:
    """Start four independent one-GPU containers and time each restore.

    This is the check that answers "do four lanes scale to four containers",
    and the one to run before raising `S2C_MAX_CONTAINERS` to 4. It does not
    use multi-GPU code: each call is its own one-GPU container.
    """
    print(f"fanout {APP_NAME}.{CLASS_NAME} …")
    _require_empty_input_queue()
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


@app.local_entrypoint()
def snapshot_state(timeout: float = 10.0) -> None:
    """**Read-only** preflight: is a snapshot ready to serve right now?

    Answers the question an owner has before taking traffic, without spending
    a GPU-minute: it reads `GET /ready` on the CPU function only. A snapshot is
    ready when `warm_containers >= 1` for the current build. Anything else —
    `starting_containers > 0` in particular — means a build is in progress or
    a deploy has invalidated every snapshot, and a customer book would either
    wait or pay for it.

    Exit codes: ``0`` ready to serve; ``1`` no warm container. It never starts
    a container, never writes the autoscaler, and never runs a GPU function.

    Run this after a deploy and before pointing traffic at the app:

        python3 -m modal run modal/s2_clone_warm.py::snapshot_state

    If it reports nothing warm, run the documented owner warm step
    (``::prewarm``, or ``scripts/s2/post-deploy-cover.sh`` for the full
    compile-then-restore check) and re-run this.
    """
    import json
    import os

    import modal as modal_mod

    from s2_contract import deploy_identity

    identity = deploy_identity(os.environ)
    print(f"snapshot-state app={identity['S2C_APP_NAME']} (CPU /ready only)")
    ready_fn = modal_mod.Function.from_name(identity["S2C_APP_NAME"], "ready")
    body = ready_fn.remote()
    # `ready` returns a payload with `ready` and `warm_containers`. It may be a
    # dict or a JSONResponse-like object depending on the client.
    payload = body if isinstance(body, dict) else getattr(body, "body", None)
    if payload is None and isinstance(body, (bytes, bytearray)):
        payload = body
    if isinstance(payload, (bytes, bytearray)):
        payload = json.loads(payload.decode("utf-8"))
    if not isinstance(payload, dict):
        print(f"unexpected /ready body: {body!r}", file=sys.stderr)
        raise SystemExit(1)
    warm = int(payload.get("warm_containers") or 0)
    starting = int(payload.get("starting_containers") or 0)
    print(
        f"warm={warm} starting={starting} "
        f"max={payload.get('max_containers')} build={payload.get('build')}"
    )
    if warm < 1:
        print(
            "NO WARM SNAPSHOT: a book placed now would "
            + (
                "wait behind the build in progress."
                if starting > 0
                else "build one on the customer's bill."
            ),
            file=sys.stderr,
        )
        raise SystemExit(1)
    print("ready: a restored container is serving this build")


@app.local_entrypoint()
def prewarm(rpc_timeout: int = 90) -> None:
    """One restore-only status() call. This is not ::cover.

    Cover may sit through a compile and must not be cancelled. This
    entrypoint cancels its own timed-out status() so a 90s get cannot
    become a second compile. Never cancel a FunctionCall during
    enter/compile of a cover run.
    """
    _require_empty_input_queue()
    worker = modal.Cls.from_name(APP_NAME, CLASS_NAME)
    handle = worker().status.spawn()
    try:
        status = handle.get(timeout=rpc_timeout)
    except Exception as err:
        # False: this status() may share the container with a book's
        # render_batch. Terminating the container would kill that H100.
        try:
            handle.cancel(terminate_containers=False)
        except Exception as cancel_err:
            print(f"prewarm cancel failed: {cancel_err}", file=sys.stderr)
        print(f"prewarm cancelled after {rpc_timeout}s: {err}", file=sys.stderr)
        raise SystemExit(1) from err
    if not isinstance(status, dict):
        print(status)
        return
    print(status)
