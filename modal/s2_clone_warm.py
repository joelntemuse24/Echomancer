"""Build and verify the clone service's GPU snapshot after a deploy.

Run this right after deploying:

    # staging app (never touches production)
    S2C_APP_NAME=echomancer-s2-clone-staging \
      modal run modal/s2_clone_warm.py --warm --verify

Why not just call the endpoint: Modal's web proxy drops a request at ~542 s,
and a fresh GPU snapshot takes ~15 min. The container is killed mid-compile, so
the snapshot never finishes and every later call repeats the same 9-minute
death. This talks to the class over the client RPC, which has no proxy limit.

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
import time

import modal

from s2_contract import (
    WARM_REFERENCE_TEXT,
    ReferenceClipError,
    ReferenceTextError,
    validate_reference_audio,
    validate_reference_text,
    warm_reference_wav,
)

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
    snapshot; on a warm deploy it restores in seconds."""
    started = time.time()
    result = worker().status.remote()
    elapsed = time.time() - started
    result["wall_s"] = round(elapsed, 1)
    print(
        f"build={result.get('build')} container={result.get('container_id')} "
        f"answered in {elapsed:.0f}s (restored_s={result.get('restored_s')})"
    )
    if elapsed > 300:
        print(
            "  that took >5 min, so this call very likely BUILT the snapshot."
        )
    return result


def _verify_restores(worker, containers: int, scaledown: int) -> list[dict]:
    """Start `containers` distinct containers and prove each restored.

    Spaced past `scaledown_window` so a warm container cannot answer the next
    call. `restored_s` is the gap between the snapshot mark and readiness: a
    compile shows up as minutes, a restore as tens of seconds.
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
        restored = status.get("restored_s")
        verdict = (
            "restored"
            if isinstance(restored, (int, float)) and restored < 60
            else "COMPILED (no snapshot)"
        )
        print(
            f"  container {i}: {verdict} wall={wall:.0f}s restored_s={restored} "
            f"id={status.get('container_id')} build={status.get('build')}"
        )
        results.append({**status, "wall_s": round(wall, 1), "verdict": verdict})
    return results


def _synth_batch(worker, ref_b64: str, ref_text: str) -> dict:
    """One batch through the same code the HTTP endpoint uses."""
    started = time.time()
    result = worker().synthesize_section.remote(
        BATCH_TEXTS[0], ref_b64, ref_text, "0.9,0.9"
    )
    single_s = time.time() - started
    print(
        f"  single section: {result['duration_s']}s audio in {result['call_s']}s "
        f"({result['realtime_x']}x), truncated_units={result['truncated_units']}, "
        f"build={result.get('build')}"
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
        restored = [r for r in restores if r["verdict"] == "restored"]
        if len(restored) < len(restores):
            print(
                "\n  Some containers compiled instead of restoring. That is "
                "expected for a new deploy or a worker variant that has not "
                "seen this build yet: re-run --verify until every container "
                "reports `restored`. Modal needs 2-3 snapshots per GPU type."
            )

    if synth:
        print("\n== 3. short synthesis through the clone path ==")
        _synth_batch(worker, ref_b64, ref_text)

    print(
        "\nDone. If step 1 took ~15 min this run created the snapshot; later "
        "calls should restore in ~90s cold and milliseconds warm.\n"
        "Next: run scripts/s2/staging-smoke.mjs against the deployed /ready and "
        "/synthesize_batch endpoints (see docs/s2-gpu-staging-runbook.md)."
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


@app.local_entrypoint()
def fanout(containers: int = 4, scaledown: int = 300) -> None:
    """Start four independent one-GPU containers and time each restore.

    This is the check that answers "do four lanes scale to four containers",
    and the one to run before raising `S2C_MAX_CONTAINERS` to 4. It does not
    use multi-GPU code: each call is its own one-GPU container.
    """
    worker = modal.Cls.from_name(APP_NAME, CLASS_NAME)
    started = time.time()
    calls = [worker().status.spawn() for _ in range(max(1, containers))]
    results = []
    for call in calls:
        try:
            results.append(call.get(timeout=1800))
        except Exception as err:  # a spawn that never landed is a real finding
            results.append({"error": str(err)})
    wall = time.time() - started
    ids = {r.get("container_id") for r in results if r.get("container_id")}
    restored = [
        r.get("restored_s")
        for r in results
        if isinstance(r.get("restored_s"), (int, float))
    ]
    print(f"{len(results)} calls in {wall:.0f}s; {len(ids)} distinct container(s)")
    for i, result in enumerate(results):
        print(f"  {i}: {result}")
    if restored:
        print(
            f"  restore time: min {min(restored):.1f}s, "
            f"median {statistics.median(restored):.1f}s, max {max(restored):.1f}s"
        )
    if len(ids) < len(results):
        print(
            "  Fewer containers than calls: some calls shared one. Raise the "
            "concurrency or space the calls out; four lanes need four containers."
        )
    print(
        f"\n  scale-to-zero check: re-run after {scaledown}s idle; every "
        "container should be gone from the Modal dashboard's Containers tab."
    )
