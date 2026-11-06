"""Production clone endpoint: one section in, one mastered MP3 out.

This is the HTTP face of the batched S2-Pro worker for the Echomancer clone
path. It is the clone engine; the hosted Drama 3 call it replaced has been
removed (it did not speak the clone), so a clone is rendered here or by the
direct Fish API that trained the reference. It keeps the section pipeline: the
app still splits a book into sections, streams section audio, masters it per
section and joins the MP3s.

    POST /synthesize
    {"text": "...", "reference_audio_base64": "...", "reference_text": "...",
     "sampling": "0.9,0.9", "job_id": "...", "seed": 123}
    -> audio/mpeg (mastered), or JSON error

    POST /synthesize_batch
    {"items": [{"key": "12", "text": "..."}], "reference_audio_base64": "...",
     "reference_text": "...", "sampling": "0.9,0.9", "job_id": "...",
     "seed": 123, "seed_epoch": 0}
    -> {"items": [{"key", "audio_b64", "duration_s", "units", ...}],
        "build", "container_id", "seed", "performance"}

Units: the text is split the way the batch pipeline splits a book (whole
paragraphs, ~400 chars, never inside a sentence). All units of a section go
through ONE slot, so each unit hears the previous one and the section keeps
its pace. A batch call gives every section its own row, so rows are
independent and share each weight read.

The mastering chain is `s2_mastering.S2_SPECTRAL_CHAIN`; loudness is left to
the app's per-section pass so a book is not normalised twice.

## Deployment shape

One frozen app, `min_containers=0`, up to `S2C_MAX_CONTAINERS` independent
one-GPU containers. Four lanes means four concurrent batch calls, and Modal
starts one container per concurrent call. Multi-GPU inside one container is
deliberately not used: GPU memory snapshots are documented as generally
incompatible with multi-GPU programs.

    modal deploy modal/s2_clone_service.py
    modal run modal/s2_clone_warm.py          # builds+verifies the snapshot

Every deploy invalidates the snapshot, and a rebuild takes ~15 min. Modal's
web proxy drops a request after ~542 s, so an HTTP call cannot build the first
snapshot: it fails with 502 and the container is killed mid-compile, leaving
nothing behind. Warm it over the client RPC (no proxy limit) instead. That is
what `s2_clone_warm.py` does; see `docs/s2-gpu-staging-runbook.md`.

`S2C_BUILD` identifies the code+config a snapshot belongs to. It is written
into every container heartbeat and every response, so "this box restored a
snapshot from last week" is visible instead of looking like a quality
regression. Modal obsoletes snapshots on redeploy, but nothing tells a
container which snapshot it restored from.

`GET /ready` is a CPU function in this app. It reads the container heartbeat
dict and reports whether a container has **finished restoring** — a runner
count alone cannot tell "restoring" from "ready". The GPU class still serves
`POST /synthesize` and `POST /synthesize_batch`.

Set `MODAL_S2_TTS_URL` in the Next.js app to the printed web endpoint and
`CLONE_TTS_PROVIDER=modal`. The app sends `x-echomancer-token`, which must
match the `MODAL_S2_TOKEN` secret.
"""

from __future__ import annotations

import base64
import hashlib
import os
import subprocess
import threading
import time
import uuid

import modal
from fastapi import Request

from s2_batch import (
    BATCH,
    GPU,
    MAX_SEQ_LEN,
    _BatchEngine,
    gpu_image,
    make_units,
)
from s2_contract import (
    BOOT_RESTORED,
    BOOT_UNKNOWN,
    GpuExecutor,
    GpuThreadBusy,
    GpuThreadError,
    HISTORY_ANCHOR_FIRST,
    PARAGRAPH_PAUSE_S,
    SamplingError,
    SPLIT_PAUSE_S,
    UNIT_MAX_CHARS,
    WARM_REFERENCE_TEXT,
    ReferenceClipError,
    ReferenceTextError,
    boot_kind,
    container_limits,
    parse_sampling,
    decoded_reference_stats,
    seed_for_call,
    snapshot_age_s,
    snapshot_fingerprint,
    validate_reference_audio,
    validate_reference_text,
    warm_reference_wav,
)
from s2_mastering import S2_SPECTRAL_CHAIN, SECTION_MP3_BITRATE, SECTION_SAMPLE_RATE

APP_NAME = os.environ.get("S2C_APP_NAME", "echomancer-s2-clone")
DEFAULT_SAMPLING = os.environ.get("S2C_SAMPLING", "0.9,0.9")
# Bump when methods or the restored object shape change: a restored snapshot
# does not always pick up new code, and a stale one fails with KeyError(method).
#: Bumped to 7: history re-anchors to the row's first take and unit pauses move
#: toward the reference (see the conditioning block in `s2_contract.py`).
S2C_VERSION = os.environ.get("S2C_VERSION", "7")

#: A heartbeat older than this means the container is gone. Kept small because
#: live containers refresh on a timer (see `publish`), not only when they serve
#: a call: the timer is what lets this be tight without dropping a warm-but-idle
#: container from `/ready`.
HEARTBEAT_TTL_SECONDS = int(os.environ.get("S2C_HEARTBEAT_TTL", "90"))
#: Refresh a container's heartbeat at most this often (seconds). The timer uses
#: it; a call-triggered refresh is throttled by the same value.
HEARTBEAT_MIN_INTERVAL = int(os.environ.get("S2C_HEARTBEAT_INTERVAL", "30"))
#: Boot registry name. A staging app must set its own, or its `/ready` would
#: report production's containers and vice versa.
HEARTBEAT_DICT_NAME = os.environ.get(
    "S2C_HEARTBEAT_DICT", f"{APP_NAME}-heartbeats"
)

_LIMITS = container_limits(os.environ)

_BUILD_ENV = {
    "S2C_BUILD": snapshot_fingerprint(
        {
            "app": APP_NAME,
            "version": S2C_VERSION,
            "gpu": GPU,
            "batch": BATCH,
            "seq": MAX_SEQ_LEN,
            "units": f"{UNIT_MAX_CHARS}",
            # Conditioning and pause recipe travel with the build id so a stale
            # container cannot be mistaken for one running the current voice
            # behaviour. `job 12534aaa` was rendered while the drift fix and the
            # pause widths were changing; without these the build id would not
            # distinguish them.
            "anchor": "first" if HISTORY_ANCHOR_FIRST else "last",
            "pause": f"{SPLIT_PAUSE_S}/{PARAGRAPH_PAUSE_S}",
            "mastering": S2_SPECTRAL_CHAIN,
            "sampling": DEFAULT_SAMPLING,
        }
    ),
    "S2C_VERSION": S2C_VERSION,
    "S2C_MAX_CONTAINERS": str(_LIMITS["max_containers"]),
    "S2C_LANES": str(_LIMITS["lanes"]),
    # Both the GPU class and the CPU probe resolve the registry from this, so a
    # staging deploy cannot read production's heartbeats.
    "S2C_HEARTBEAT_DICT": HEARTBEAT_DICT_NAME,
}


def _max_containers() -> int:
    """Independent one-GPU containers.

    Production stays at 1 until the staging runbook has shown four lanes
    restoring the same snapshot and finishing a real book. A cold container
    spends ~20 min compiling, and four of those at once exhausted the Modal
    budget on 25 Oct, so the default is deliberately conservative and the
    value is a single env var (`S2C_MAX_CONTAINERS`) rather than a code edit.
    """
    return int(_LIMITS["max_containers"])


def _token_ok(request: Request) -> bool:
    expected = os.environ.get("MODAL_S2_TOKEN", "").strip()
    return bool(expected) and request.headers.get("x-echomancer-token") == expected


def _apply_seed(seed) -> int:
    """Reseed before every call so a restored snapshot cannot repeat a take.

    A GPU memory snapshot captures whatever RNG state the snapshotting
    container had, so two containers restoring the same snapshot would draw
    identical samples. The app sends a seed derived from (job, section,
    retry epoch); when it sends none we derive one from the request itself.
    """
    import torch

    try:
        value = int(seed)
    except (TypeError, ValueError):
        value = 0
    value = abs(value) % (2**31 - 1)
    if not value:
        value = seed_for_call(None, None, int(time.time() * 1000))
    torch.manual_seed(value)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(value)
    return value


def _error(code: str, message: str, status: int = 400) -> tuple[dict, int]:
    return {"error": message, "code": code, "build": _BUILD_ENV["S2C_BUILD"]}, status


app = modal.App(APP_NAME)

# Modal mounts only the entrypoint file by default, so the modules this app
# imports must be added explicitly or the container fails at import time.
# FastAPI is also required for the web endpoint. Both are layered on top so the
# batch app's image, and its snapshots, stay untouched.
web_image = (
    gpu_image.pip_install("fastapi[standard]==0.115.6")
    .add_local_python_source("s2_batch", "s2_mastering", "s2_contract", copy=True)
)

#: Shared boot registry: one entry per container, written after restore.
heartbeats = modal.Dict.from_name(HEARTBEAT_DICT_NAME, create_if_missing=True)


def _section_units(text: str) -> list[dict]:
    """Split one section into paragraph units, the same way a book is split."""
    if len(text) > 60_000:
        raise ValueError("section is too large")
    units = make_units([t.strip() for t in text.split("\n\n") if t.strip()])
    for unit in units:
        if len(unit["text"]) > UNIT_MAX_CHARS:
            raise ValueError(f"unit of {len(unit['text'])} chars was not split")
    return units


def _master(samples, sample_rate: int, out_path: str) -> None:
    """Spectral chain to a mono MP3. Gain stays with the app's loudness pass."""
    import numpy as np

    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16).tobytes()
    subprocess.run(
        [
            "ffmpeg", "-y", "-v", "error",
            "-f", "s16le", "-ar", str(sample_rate), "-ac", "1", "-i", "-",
            "-af", S2_SPECTRAL_CHAIN,
            "-ar", str(SECTION_SAMPLE_RATE), "-ac", "1",
            "-c:a", "libmp3lame", "-b:a", SECTION_MP3_BITRATE,
            "-write_xing", "0",  # sections are copy-joined; no per-section TOC
            out_path,
        ],
        input=pcm,
        check=True,
    )


def _prepare_reference(audio: bytes, ref_text: str) -> str:
    """Validate a reference clip + transcript before any GPU work.

    The October warm-up failed with an empty clip and a `torchaudio.load`
    stack trace that did not say what was wrong. These checks name the fault,
    and they run before the reference is encoded so a bad clip costs nothing.
    """
    validate_reference_audio(audio)
    return validate_reference_text(ref_text)


@app.cls(
    image=web_image,
    gpu=GPU,
    cpu=4,
    memory=32768,
    # The token lives in its own secret so rotating it never touches the other
    # Echomancer credentials.
    secrets=[
        modal.Secret.from_name("echomancer-secrets"),
        modal.Secret.from_name("echomancer-s2-api"),
    ],
    scaledown_window=_LIMITS["scaledown_window"],
    # The first call on a fresh deployment also builds the snapshot, which can
    # take 15+ minutes; a 900 s cap killed that request mid-compile.
    timeout=int(os.environ.get("S2C_TIMEOUT", "3600")),
    # Scale-to-zero when idle. Modal needs 2-3 snapshots per GPU type, so the
    # first few cold boots each pay a full compile; warm them up before a book.
    min_containers=_LIMITS["min_containers"],
    max_containers=_max_containers(),
    buffer_containers=_LIMITS["buffer_containers"],
    enable_memory_snapshot=True,
    experimental_options={"enable_gpu_snapshot": True},
    env={
        "S2B_GPU": GPU,
        "S2B_BATCH": str(BATCH),
        "S2B_MAX_SEQ_LEN": str(MAX_SEQ_LEN),
        **_BUILD_ENV,
    },
)
class S2CloneWorker:
    @modal.enter(snap=True)
    def load(self) -> None:
        """Own the GPU thread, load weights and warm both prompt shapes.

        Everything CUDA happens on `self.gpu`, a thread this method starts. That
        thread is the one that owns the CUDA context when the snapshot is taken,
        so after a restore only it has a working cuBLAS handle. Modal serves a
        sync FastAPI endpoint on a fresh worker thread per request, and a
        `cublasCreate` from there fails with `CUBLAS_STATUS_ALLOC_FAILED` — the
        failure staging saw on `/synthesize_batch` while `.remote()` kept
        working in the same container.
        """
        # Marks captured *inside* the snapshot, so after a restore they describe
        # the container that built it. `monotonic` is the host's uptime, which is
        # what makes a restore detectable (see boot_kind); the wall mark is only
        # ever used for build age.
        self.snap_wall = time.time()
        self.snap_monotonic = time.monotonic()
        self.gpu = GpuExecutor("s2-gpu")

        def init() -> None:
            import torch

            torch.cuda.init()
            self.engine = _BatchEngine()
            self.weights_loaded_at = time.time()
            # Two forward passes: text only, then with a reference. The second
            # one is the path every clone call takes, so its kernels and both
            # prompt shapes are compiled here instead of on a customer's
            # section. Both run on the GPU thread, which is the point.
            self.engine.warm_up()
            self.compiled_at = time.time()
            # Burn the allocator paths that failed on the request thread so any
            # remaining thread-affinity problem shows up at boot, not at 3am.
            # This runs before reset_state because it allocates and decodes.
            self.engine.selftest()
            # Customer material must never end up inside a snapshot, and a
            # filled KV cache is meaningless after restore. Drop both *after*
            # every warm-up call, so the captured image is clean.
            self.engine.reset_state()

        self.boot_started = time.time()
        self.gpu.start(init, timeout=float(os.environ.get("S2C_INIT_TIMEOUT", "1800")))
        self.ref_cache: dict[str, tuple] = {}
        self.transcripts: dict[str, str] = {}
        print(
            f"[S2C] build={_BUILD_ENV['S2C_BUILD']} "
            f"gpu_thread={self.gpu.thread_ident} "
            f"weights {self.weights_loaded_at - self.boot_started:.1f}s, "
            f"compile+warm {self.compiled_at - self.weights_loaded_at:.1f}s"
        )

    @modal.enter()
    def publish(self) -> None:
        """Runs on every container start, after a restore. Not snapshotted.

        The only place a restore can be recognised, because this hook always
        executes while the marks it compares against were captured.
        """
        self.ready_at = time.time()
        self.container_id = os.environ.get("MODAL_CONTAINER_ID") or uuid.uuid4().hex[:12]
        self.calls = 0
        self._heartbeat_at = 0.0
        self._stopped = threading.Event()
        kind = boot_kind(
            snap_monotonic=getattr(self, "snap_monotonic", None),
            now_monotonic=time.monotonic(),
        )
        self.boot_kind = kind
        self.snapshot_age_s = snapshot_age_s(
            snap_wall=getattr(self, "snap_wall", None),
            now_wall=self.ready_at,
            boot=kind,
        )
        # A restored snapshot carries the snapshotting container's RNG state.
        # Reseed on the GPU thread, and every call reseeds again from its own
        # identity, so two containers never produce the same take.
        self.gpu.submit(
            lambda: _apply_seed(seed_for_call(self.container_id, "boot", int(self.ready_at)))
        )
        # Say plainly what is and is not known. A `boot=unknown` here is normal:
        # only a restore onto a younger host is provable from inside, and Modal's
        # own log line is the authoritative record either way.
        print(
            f"[S2C] container={self.container_id} build={_BUILD_ENV['S2C_BUILD']} "
            f"boot={kind} snapshot_age={self.snapshot_age_s}s "
            f"(restore duration is only measurable client-side)"
        )
        self._heartbeat(force=True)
        self._start_heartbeat_timer()

    # ── liveness ───────────────────────────────────────────────────────────

    def _start_heartbeat_timer(self) -> None:
        """Refresh this container's heartbeat while it is up.

        `/ready` decides "is anything warm?" from these entries, so the honest
        fix for a stale count is to keep a *live* entry fresh rather than to
        trust an old one for minutes. A call-triggered heartbeat alone cannot do
        that: a container sitting idle between sections writes nothing, so its
        entry ages out and it vanishes from `/ready` even though it is ready. A
        background timer makes a short TTL safe.
        """
        interval = max(5, HEARTBEAT_MIN_INTERVAL)

        def tick() -> None:
            while not self._stopped.is_set():
                self._heartbeat(force=True)
                # Wake early on shutdown so `exit` is not delayed by a sleep.
                self._stopped.wait(interval)

        self._heartbeat_thread = threading.Thread(
            target=tick, name="s2-heartbeat", daemon=True
        )
        self._heartbeat_thread.start()

    @modal.exit()
    def exit(self) -> None:
        """Remove this container's heartbeat the moment it stops.

        Scaledown/preemption is announced here, and without this hook the entry
        survives until its TTL expires — which is what let `/ready` report more
        warm containers than `max_containers` right after a container scaled
        down. Removing it makes the count correct immediately in the common
        case; the TTL remains the backstop for an ungraceful kill, which cannot
        run any hook at all.

        Deliberately does *not* tear down the GPU executor. Modal allows a short
        grace period here, and a request may still be finishing inside it: the
        heartbeat is what `/ready` reads, but the process is going away either
        way, so the only thing worth doing is the bookkeeping.
        """
        self._stopped.set()
        try:
            heartbeats.pop(self.container_id, None)
        except Exception as err:  # never fail teardown on bookkeeping
            print(f"[S2C] heartbeat removal failed: {err}")

    def _heartbeat(self, force: bool = False) -> None:
        """Publish "this container has finished restoring" for `/ready`."""
        now = time.time()
        if not force and now - self._heartbeat_at < HEARTBEAT_MIN_INTERVAL:
            return
        self._heartbeat_at = now
        try:
            heartbeats[self.container_id] = {
                "build": _BUILD_ENV["S2C_BUILD"],
                "version": S2C_VERSION,
                "state": "ready",
                "boot": getattr(self, "boot_kind", BOOT_UNKNOWN),
                "at": int(now),
                "snapshot_age_s": getattr(self, "snapshot_age_s", None),
                "calls": self.calls,
            }
        except Exception as err:  # a heartbeat must never fail a synthesis
            print(f"[S2C] heartbeat write failed: {err}")

    @modal.method()
    def status(self) -> dict:
        """Runbook/health view of one container. Also forces a heartbeat."""
        self._heartbeat(force=True)
        return {
            "container_id": self.container_id,
            "build": _BUILD_ENV["S2C_BUILD"],
            "version": S2C_VERSION,
            "gpu": GPU,
            "batch": BATCH,
            "lanes": _LIMITS["lanes"],
            "max_containers": _max_containers(),
            "since_ready_s": round(time.time() - self.ready_at, 1),
            "boot": getattr(self, "boot_kind", BOOT_UNKNOWN),
            "snapshot_age_s": getattr(self, "snapshot_age_s", None),
            "gpu_thread": self.gpu.thread_ident,
            "gpu_jobs": self.gpu.jobs_done,
            "calls": self.calls,
            "refs_cached": len(self.ref_cache),
        }

    def _resolve_reference(
        self, audio: bytes, ref_text: str, *, timeout: float | None = None
    ) -> tuple[tuple, str, dict]:
        """Encode the clip once per container, transcribe once when needed.

        Must be called on the GPU thread: encoding runs the codec decoder on
        CUDA, and a request thread in a restored container has no usable handle.

        The stats reported back are the decoded ones, so an MP3/M4A reference
        has a real `seconds`/`rms` instead of the `null`s the WAV-only reader
        returned for every non-WAV clip. That was the state in which
        `job 5f09ee0e` failed with no clue which container the reference was.
        """
        stats = decoded_reference_stats(audio)
        key = hashlib.sha256(audio).hexdigest()
        if key not in self.ref_cache:
            self.ref_cache[key] = self.engine.encode_reference(audio)
        if not ref_text:
            if key not in self.transcripts:
                self.transcripts[key] = self.engine.transcribe_reference(audio)
            ref_text = self.transcripts[key]
        # Fish drops a reference with no text, which silently stops cloning.
        ref_text = validate_reference_text(ref_text)
        return (self.ref_cache[key], ref_text), key, stats

    def _run_on_gpu(self, fn, *, timeout: float | None = None):
        """Submit GPU work from a request thread and translate the failure modes.

        HTTP handlers never touch CUDA themselves. Three things can go wrong
        here, and each maps to a different caller decision:

        - `GpuThreadBusy`  ⇒ 429, the lane is occupied; try another container.
        - `TimeoutError`   ⇒ 503, this boot is still warming; come back later.
        - anything else    ⇒ 500, a real fault that must not look like cold.

        `S2C_GPU_WAIT_S` bounds how long a second caller waits for the lane to be
        free before getting a retryable 429. Keeping it short is deliberate: the
        app has four lanes and a parked book, so bouncing to another lane is
        better than holding an HTTP connection open behind one long batch. The
        job itself is unbounded, because a full batch legitimately takes minutes.
        """
        if timeout is None:
            raw = os.environ.get("S2C_GPU_WAIT_S", "0")
            try:
                timeout = max(0.0, float(raw))
            except ValueError:
                timeout = 0.0
        return self.gpu.submit(fn, queue_timeout=timeout)

    # The endpoint lives on the class so the request is handled by the container
    # that already holds the model. A separate function calling .remote() adds a
    # hop whose own timeout can kill a long first call.
    @modal.fastapi_endpoint(method="POST", docs=False)
    def synthesize(self, payload: dict, request: Request):
        """One section in, one mastered MP3 out."""
        from fastapi import HTTPException
        from fastapi.responses import JSONResponse, Response

        if not _token_ok(request):
            raise HTTPException(status_code=401, detail="unauthorized")

        text = (payload.get("text") or "").strip()
        ref_b64 = payload.get("reference_audio_base64") or ""
        ref_text = (payload.get("reference_text") or "").strip()
        if not text or not ref_b64:
            body, status = _error(
                "request_invalid", "text and reference_audio_base64 are required"
            )
            raise HTTPException(status_code=status, detail=body)
        try:
            result = self._synthesize_section(
                text,
                ref_b64,
                ref_text,
                payload.get("sampling") or "",
                payload.get("seed"),
                payload.get("job_id"),
                payload.get("seed_epoch"),
            )
        except GpuThreadBusy as err:
            body, status = _error("lane_busy", str(err), 429)
            raise HTTPException(status_code=status, detail=body) from err
        except TimeoutError as err:
            body, status = _error("boot_warming", str(err), 503)
            raise HTTPException(status_code=status, detail=body) from err
        except GpuThreadError as err:
            body, status = _error("gpu_thread_unavailable", str(err), 503)
            raise HTTPException(status_code=status, detail=body) from err
        except (ReferenceClipError, ReferenceTextError) as err:
            body, status = _error("reference_invalid", str(err), 422)
            raise HTTPException(status_code=status, detail=body) from err
        except SamplingError as err:
            body, status = _error("sampling_invalid", str(err), 422)
            raise HTTPException(status_code=status, detail=body) from err
        except ValueError as err:
            body, status = _error("section_invalid", str(err), 422)
            raise HTTPException(status_code=status, detail=body) from err

        if payload.get("json"):
            return JSONResponse(result)
        return Response(
            base64.b64decode(result["audio_b64"]),
            media_type="audio/mpeg",
            headers={
                "x-s2-duration": str(result["duration_s"]),
                "x-s2-call-ms": str(int(result["call_s"] * 1000)),
                "x-s2-units": str(result["units"]),
                "x-s2-truncated": str(result.get("truncated_units") or 0),
                "x-s2-seed": str(result.get("seed") or 0),
                "x-s2-build": _BUILD_ENV["S2C_BUILD"],
                "x-s2-container": self.container_id,
                "x-s2-boot": getattr(self, "boot_kind", BOOT_UNKNOWN),
            },
        )

    @modal.fastapi_endpoint(method="POST", docs=False)
    def synthesize_batch(self, payload: dict, request: Request):
        """Many sections in one call; one batch row per section.

        Each section is its own row, so every row hears only the reference and
        keeps its own rhythm. Batching across sections is what makes the GPU
        worth its price: rows share each weight read.

        Row contract (the app reads `audio_b64`):
            {"key", "audio_b64", "duration_s", "units", "truncated_units"}
        or, for a section this call could not render:
            {"key", "error", "error_code"}
        """
        import tempfile
        from concurrent.futures import ThreadPoolExecutor

        from fastapi import HTTPException
        from fastapi.responses import JSONResponse

        if not _token_ok(request):
            raise HTTPException(status_code=401, detail="unauthorized")

        items = payload.get("items") or []
        ref_b64 = payload.get("reference_audio_base64") or ""
        ref_text = (payload.get("reference_text") or "").strip()
        if not items or not ref_b64:
            body, status = _error(
                "request_invalid", "items and reference_audio_base64 are required"
            )
            raise HTTPException(status_code=status, detail=body)

        max_items = int(os.environ.get("S2C_MAX_BATCH_ITEMS", "24"))
        if len(items) > max_items:
            body, status = _error(
                "batch_too_large",
                f"{len(items)} sections > {max_items} per call; send fewer",
                422,
            )
            raise HTTPException(status_code=status, detail=body)
        keys = [str(item.get("key") or "") for item in items]
        if any(not k for k in keys):
            body, status = _error("request_invalid", "every item needs a key")
            raise HTTPException(status_code=status, detail=body)
        if len(set(keys)) != len(keys):
            body, status = _error("request_invalid", "duplicate item keys")
            raise HTTPException(status_code=status, detail=body)

        t0 = time.time()
        try:
            audio = base64.b64decode(ref_b64)
            validate_reference_audio(audio)
            sampling = parse_sampling(payload.get("sampling"), DEFAULT_SAMPLING)
        except (ReferenceClipError, ReferenceTextError) as err:
            body, status = _error("reference_invalid", str(err), 422)
            raise HTTPException(status_code=status, detail=body) from err
        except SamplingError as err:
            body, status = _error("sampling_invalid", str(err), 422)
            raise HTTPException(status_code=status, detail=body) from err

        # One slot per section. Sections that do not fit become their own call.
        units_by_item, errors = [], {}
        for item, key in zip(items, keys):
            try:
                units = _section_units(item.get("text") or "")
                if not units:
                    raise ValueError("no speakable text")
                units_by_item.append((key, units))
            except ValueError as err:
                errors[key] = ("empty_text" if "no speakable" in str(err) else "invalid_text", str(err))

        slots = [units for _, units in units_by_item]
        seed_value = (
            payload.get("seed")
            if payload.get("seed") not in (None, "")
            else seed_for_call(
                payload.get("job_id"),
                ",".join(keys),
                int(payload.get("seed_epoch") or 0),
            )
        )
        sampling_text = f"{sampling[0]},{sampling[1]}"
        self.calls += 1

        def gpu_work() -> dict:
            """Everything that touches CUDA or the codec, on the GPU thread.

            Reference encoding, every decode batch, codec decode and the
            per-section ffmpeg gain/mix all stay on this one thread, so no
            FastAPI worker thread ever opens a CUDA handle.
            """
            ref, ref_key, ref_stats = self._resolve_reference(audio, ref_text)
            calls_seed = _apply_seed(seed_value)
            stats_all = {"frames": 0, "steps": 0, "truncated_units": 0}
            codes: list = []
            truncated_by_slot: list[int] = []
            prepared_at = time.time()
            for start in range(0, len(slots), BATCH):
                stats = self.engine.render(
                    slots[start : start + BATCH],
                    ref,
                    sampling_text,
                )
                codes.extend(stats.pop("codes"))
                truncated_by_slot.extend(stats.pop("truncated_by_slot", []))
                for k in ("frames", "steps"):
                    stats_all[k] += stats.get(k, 0)
                stats_all["truncated_units"] += int(
                    stats.get("truncated_units") or 0
                )
            generated_at = time.time()
            rendered = self.engine.decode_slots(codes, slots) if codes else []
            decoded_at = time.time()
            sample_rate = self.engine.sample_rate
            return {
                "ref_key": ref_key,
                "ref_stats": ref_stats,
                "seed": calls_seed,
                "stats": stats_all,
                "truncated_by_slot": truncated_by_slot,
                "rendered": rendered,
                "sample_rate": sample_rate,
                "t_prepare": prepared_at,
                "t_gen": generated_at,
                "t_codec": decoded_at,
            }

        try:
            done = self._run_on_gpu(gpu_work)
        except GpuThreadBusy as err:
            body, status = _error("lane_busy", str(err), 429)
            raise HTTPException(status_code=status, detail=body) from err
        except TimeoutError as err:
            body, status = _error("boot_warming", str(err), 503)
            raise HTTPException(status_code=status, detail=body) from err
        except GpuThreadError as err:
            body, status = _error("gpu_thread_unavailable", str(err), 503)
            raise HTTPException(status_code=status, detail=body) from err
        except (ReferenceClipError, ReferenceTextError) as err:
            body, status = _error("reference_invalid", str(err), 422)
            raise HTTPException(status_code=status, detail=body) from err

        rendered = done["rendered"]
        sample_rate = done["sample_rate"]
        # ffmpeg is one process per section; running them in parallel turns
        # ~7 s of per-call encode into ~2 s on a 4-CPU container. These touch
        # no CUDA state, so they stay off the GPU thread.
        def encode(samples) -> bytes:
            with tempfile.NamedTemporaryFile(suffix=".mp3") as f:
                _master(samples, sample_rate, f.name)
                with open(f.name, "rb") as fh:
                    return fh.read()

        with ThreadPoolExecutor(4) as pool:
            mp3s = list(pool.map(encode, rendered)) if rendered else []

        rows = []
        for i, ((item_key, units), samples, mp3) in enumerate(
            zip(units_by_item, rendered, mp3s)
        ):
            rows.append({
                "key": item_key,
                "audio_b64": base64.b64encode(mp3).decode(),
                "duration_s": round(len(samples) / sample_rate, 2),
                "units": len(units),
                "truncated_units": (
                    int(done["truncated_by_slot"][i])
                    if i < len(done["truncated_by_slot"])
                    else 0
                ),
            })
        for item_key, (code, message) in errors.items():
            rows.append({"key": item_key, "error": message, "error_code": code})
        rows.sort(key=lambda row: keys.index(row["key"]))
        t_done = time.time()
        self._heartbeat()

        return JSONResponse({
            "items": rows,
            "build": _BUILD_ENV["S2C_BUILD"],
            "container_id": self.container_id,
            "boot": getattr(self, "boot_kind", BOOT_UNKNOWN),
            "seed": done["seed"],
            "sampling": sampling_text,
            "reference": {
                "sha256": done["ref_key"],
                "seconds": done["ref_stats"].get("seconds"),
                "rms": done["ref_stats"].get("rms"),
            },
            "performance": {
                "sections": len(slots),
                "audio_s": round(sum(r.get("duration_s", 0) for r in rows), 1),
                "prepare_s": round(done["t_prepare"] - t0, 2),
                "generate_s": round(done["t_gen"] - done["t_prepare"], 2),
                "codec_s": round(done["t_codec"] - done["t_gen"], 2),
                "encode_s": round(t_done - done["t_codec"], 2),
                "call_s": round(t_done - t0, 2),
                "truncated_units": done["stats"]["truncated_units"],
                "snapshot_age_s": getattr(self, "snapshot_age_s", None),
                **{
                    k: done["stats"][k]
                    for k in ("frames", "frames_per_s", "generated_realtime_x")
                    if k in done["stats"]
                },
            },
        })

    @modal.method()
    def synthesize_section(
        self,
        text: str,
        ref_b64: str,
        ref_text: str,
        sampling: str = "",
        seed=None,
    ) -> dict:
        """Benchmark/CLI entrypoint; the HTTP endpoint calls the same code.

        Runs on the GPU thread, which is why `.remote()` kept working when the
        HTTP handlers could not: Modal dispatches a method call on the thread
        that owns the context, while a sync web endpoint gets a fresh one.
        """
        return self._synthesize_section(text, ref_b64, ref_text, sampling, seed)

    def _synthesize_section(
        self,
        text: str,
        ref_b64: str,
        ref_text: str,
        sampling: str,
        seed=None,
        job_id: str | None = None,
        seed_epoch=None,
    ) -> dict:
        import tempfile

        t0 = time.time()
        units = _section_units(text)
        if not units:
            raise ValueError("section has no speakable text")

        audio = base64.b64decode(ref_b64)
        validate_reference_audio(audio)
        temperature, top_p = parse_sampling(sampling, DEFAULT_SAMPLING)
        sampling_text = f"{temperature},{top_p}"
        self.calls += 1

        def gpu_work() -> dict:
            ref, ref_key, ref_stats = self._resolve_reference(audio, ref_text)
            # A retry moves the epoch, so it renders a different take rather
            # than billing a second, identical one.
            call_seed = _apply_seed(
                seed
                if seed not in (None, "")
                else seed_for_call(job_id, text[:64], int(seed_epoch or 0))
            )
            generated_at = time.time()
            stats = self.engine.render([units], ref, sampling_text)
            truncated_by_slot = stats.pop("truncated_by_slot", [])
            coded_at = time.time()
            samples = self.engine.decode_slots(stats.pop("codes"), [units])[0]
            return {
                "ref_key": ref_key,
                "ref_stats": ref_stats,
                "seed": call_seed,
                "samples": samples,
                "truncated": int(sum(truncated_by_slot)),
                "sample_rate": self.engine.sample_rate,
                "t_gen": generated_at,
                "t_codec": coded_at,
            }

        # Called directly (.remote()) this is already the owner thread, and
        # submitting from it would deadlock on the single-flight lock, so run
        # inline. Called from the HTTP handler it hops to the GPU thread.
        done = gpu_work() if self.gpu.owns_gpu() else self._run_on_gpu(gpu_work)

        samples = done["samples"]
        with tempfile.NamedTemporaryFile(suffix=".mp3") as f:
            _master(samples, done["sample_rate"], f.name)
            with open(f.name, "rb") as fh:
                mp3 = fh.read()
        t_master = time.time()
        self._heartbeat()

        duration = len(samples) / done["sample_rate"]
        return {
            "audio_b64": base64.b64encode(mp3).decode(),
            "duration_s": round(duration, 2),
            "units": len(units),
            "truncated_units": done["truncated"],
            "generate_s": round(done["t_gen"] - t0, 2),
            "codec_s": round(done["t_codec"] - done["t_gen"], 2),
            "master_s": round(t_master - done["t_codec"], 2),
            "call_s": round(t_master - t0, 2),
            "realtime_x": round(duration / max(t_master - t0, 1e-6), 1),
            "since_warm_s": round(time.time() - self.ready_at, 1),
            "boot": getattr(self, "boot_kind", BOOT_UNKNOWN),
            "snapshot_age_s": getattr(self, "snapshot_age_s", None),
            "seed": done["seed"],
            "sampling": sampling_text,
            "build": _BUILD_ENV["S2C_BUILD"],
            "container_id": self.container_id,
            "reference": {
                "sha256": done["ref_key"],
                "seconds": done["ref_stats"].get("seconds"),
            },
        }


# CPU only. Importing this module pulls s2_batch, whose image.imports() block
# swallows a missing torch unless this container is the GPU image, so the probe
# stays off the H100. Reading a Modal Dict is control-plane work and does not
# start a GPU container.
ready_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("fastapi[standard]==0.115.6")
    .add_local_python_source("s2_batch", "s2_mastering", "s2_contract")
)


def _live_containers(build: str, *, registry=None) -> list[dict]:
    """Containers of this build that are alive right now.

    A container counts only when it has a heartbeat newer than
    `HEARTBEAT_TTL_SECONDS`. That TTL can be short (90 s) because a live
    container refreshes on a timer rather than only when it serves a call, and
    `@modal.exit()` removes the entry the moment it stops. It remains the
    backstop for an ungraceful kill, which runs no hook at all.

    An overshoot of `max_containers` is still possible for a moment while a new
    container is starting before an old one has exited — that is genuinely two
    live containers, and reporting it honestly is better than hiding it. The
    runbook documents it.
    """
    store = registry if registry is not None else heartbeats
    now = time.time()
    out: list[dict] = []
    stale: list[str] = []
    try:
        for key, value in store.items():
            if not isinstance(value, dict):
                continue
            age = now - float(value.get("at") or 0)
            if age > HEARTBEAT_TTL_SECONDS * 4:
                stale.append(key)  # from an old build; prune opportunistically
                continue
            if value.get("build") != build:
                continue
            if value.get("state") != "ready":
                continue
            if age > HEARTBEAT_TTL_SECONDS:
                continue
            out.append({**value, "age_s": round(age, 1)})
    except Exception as err:
        print(f"[S2C] heartbeat read failed: {err}")
        return []
    for key in stale[:20]:
        try:
            store.pop(key, None)
        except Exception:
            pass
    return sorted(out, key=lambda row: row.get("at") or 0, reverse=True)


@app.function(
    image=ready_image,
    cpu=0.125,
    memory=256,
    timeout=15,
    max_containers=2,
    secrets=[
        modal.Secret.from_name("echomancer-secrets"),
        modal.Secret.from_name("echomancer-s2-api"),
    ],
    env=_BUILD_ENV,
)
@modal.fastapi_endpoint(method="GET", docs=False)
def ready(request: Request):
    """Has any container of THIS build finished restoring? Does not start one.

    A runner count cannot answer this: a container that is still restoring or
    compiling already counts as a runner, which is how a cold first call used
    to look healthy right up to the 502. Containers publish a heartbeat after
    their post-restore hook runs, and only those count.

    `ready=false` is not an error: the app defers the book and comes back.
    """
    from fastapi import HTTPException
    from fastapi.responses import JSONResponse

    if not _token_ok(request):
        raise HTTPException(status_code=401, detail="unauthorized")
    build = _BUILD_ENV["S2C_BUILD"]
    live = _live_containers(build)
    payload = {
        "ready": bool(live),
        "warm_containers": len(live),
        "max_containers": _max_containers(),
        "lanes": _LIMITS["lanes"],
        "build": build,
        "version": S2C_VERSION,
        "heartbeat_ttl_s": HEARTBEAT_TTL_SECONDS,
        "containers": [
            {
                "container_id": row.get("container_id") or "",
                "age_s": row["age_s"],
                "boot": row.get("boot"),
                "snapshot_age_s": row.get("snapshot_age_s"),
                "calls": row.get("calls"),
            }
            for row in live[:8]
        ],
    }
    if not live:
        return JSONResponse(payload, status_code=503)
    return payload
