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

Units: the text is split the way the batch pipeline splits a book — a whole
paragraph is one generation, and only a paragraph past the model's frame
ceiling is packed into sentences toward ~480 chars (never inside a sentence).
All units of a section go through ONE slot, so each unit is anchored to the
row's first take and the section keeps its pace. A batch call gives every
section its own row, so rows are independent and share each weight read.

The mastering chain is `s2_mastering.S2_SPECTRAL_CHAIN`; loudness is left to
the app's per-section pass so a book is not normalised twice.

## Deployment shape

One frozen app, `min_containers=0`, up to `S2C_MAX_CONTAINERS` independent
one-GPU containers. Four lanes means four concurrent batch calls, and Modal
starts one container per concurrent call. Multi-GPU inside one container is
deliberately not used: GPU memory snapshots are documented as generally
incompatible with multi-GPU programs.

    # STAGING (what a bare command does):
    modal deploy modal/s2_clone_service.py
    modal run modal/s2_clone_warm.py          # builds+verifies the snapshot

    # PRODUCTION (must be named):
    S2C_ALLOW_PRODUCTION=1 modal deploy modal/s2_clone_service.py
    S2C_ALLOW_PRODUCTION=1 modal run modal/s2_clone_warm.py

`S2C_APP_NAME`, `S2C_ALLOW_PRODUCTION` and the heartbeat registry are resolved
by `s2_contract.resolve_app_name`, which the warm script and
`scripts/s2/check-input-queue.py` use as well — so all three always target the
same app. Production is opt-in even when its name is spelled out: a deploy
**invalidates every GPU snapshot of its app**, and a branch under review must not
be able to evict the live pool's by pasting a command from a docstring.

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
    BUCKET_BATCH,
    CODEC_TUNING,
    DAC_MICRO_BATCH,
    ENGINE,
    EOS_CHECK_EVERY,
    FAST_DECODE,
    GPU,
    KV_BUCKETS,
    MAX_NEW_FRAMES,
    MAX_SEQ_LEN,
    PIPELINE_CODEC,
    SDPA_DECODE,
    TOPK_FAST_SAMPLE,
    WORK_STEAL,
    _BatchEngine,
    _as_float_array,
    assemble_slot_audio,
    gpu_image,
    make_units,
)
from s2_contract import (
    BOOT_RESTORED,
    BOOT_UNKNOWN,
    CLAUSE_PAUSE_S,
    GpuExecutor,
    GpuThreadBusy,
    GpuThreadError,
    HISTORY_ANCHOR_FIRST,
    MERGE_PARA_MAX_CHARS,
    PARAGRAPH_PAUSE_S,
    SamplingError,
    SPLIT_PAUSE_S,
    UNIT_MAX_CHARS,
    WARM_REFERENCE_TEXT,
    ReferenceClipError,
    ReferenceTextError,
    boot_kind,
    container_limits,
    heartbeat_dict_name,
    parse_sampling,
    resolve_app_name,
    decoded_reference_stats,
    seed_for_call,
    snapshot_age_s,
    snapshot_fingerprint,
    split_long_text,
    units_summary,
    validate_reference_audio,
    validate_reference_text,
    warm_reference_wav,
)
from s2_audio_store import UploadPool, transport_name
from s2_mastering import S2_SPECTRAL_CHAIN, SECTION_MP3_BITRATE, SECTION_SAMPLE_RATE

#: The app this module deploys to. `s2_contract.resolve_app_name` is the one
#: rule the service, the warm script and the input-queue script share: production
#: needs `S2C_ALLOW_PRODUCTION=1`, even when its name is spelled out, because a
#: deploy invalidates every snapshot that app has.
APP_NAME = resolve_app_name(os.environ)
DEFAULT_SAMPLING = os.environ.get("S2C_SAMPLING", "0.9,0.9")
# Bump when methods or the restored object shape change: a restored snapshot
# does not always pick up new code, and a stale one fails with KeyError(method).
#: Bumped to 9: clone units are packed to the model's real frame ceiling
#: (target 480 / ceiling 600 chars instead of 300 / 400), a whole short
#: paragraph is one generation, and a stub tail folds into its predecessor.
#: This is the "it stops and starts every time" fix, so it needs its own build.
#:
#: Bumped to 10: the decode path changed shape. Bucketed active batch width,
#: coarse pre-warmed CUDA-graph KV buckets, a rewritten fast-transformer step
#: that no longer hands inductor a CPU constant, and a streaming
#: codec/encode/R2 pipeline all live in the restored object graph, so a
#: snapshot built from 9 must not serve this code.
S2C_VERSION = os.environ.get("S2C_VERSION", "10")

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
HEARTBEAT_DICT_NAME = heartbeat_dict_name(os.environ)

_LIMITS = container_limits(os.environ)

#: The narration recipe this build renders with.
#:
#: Reported by `status()` and `GET /ready`, written into every synthesis
#: response, and hashed into `S2C_BUILD`. A take can therefore be traced to the
#: unit width that made it: the job row keeps the `x-s2-build` the worker saw,
#: and `/ready` on the deployed app says which recipe that build name means. That
#: is the difference between "the fix is deployed" and "this book was made with
#: the fix", which is exactly what could not be told apart on 2026-11-06.
_RECIPE = {
    "unit_max_chars": UNIT_MAX_CHARS,
    "max_new_frames": MAX_NEW_FRAMES,
    "merge_para_max_chars": MERGE_PARA_MAX_CHARS,
    "history": "first" if HISTORY_ANCHOR_FIRST else "last",
    "pause_s": {
        "clause": CLAUSE_PAUSE_S,
        "sentence": SPLIT_PAUSE_S,
        "paragraph": PARAGRAPH_PAUSE_S,
    },
}

_BUILD_ENV = {
    "S2C_BUILD": snapshot_fingerprint(
        {
            "app": APP_NAME,
            "version": S2C_VERSION,
            "gpu": GPU,
            "batch": BATCH,
            "seq": MAX_SEQ_LEN,
            "unit_max": f"{UNIT_MAX_CHARS}",
            # Conditioning, pause and packing recipe travel with the build id
            # so a stale container cannot be mistaken for one running the
            # current voice behaviour. `job 12534aaa` was rendered while the
            # drift fix and the pause widths were changing; without these the
            # build id would not distinguish them. The unit width is the whole
            # point of the "stops and starts" fix, so it is in here explicitly
            # rather than implied by the version number.
            "anchor": "first" if HISTORY_ANCHOR_FIRST else "last",
            "pause": f"{CLAUSE_PAUSE_S}/{SPLIT_PAUSE_S}/{PARAGRAPH_PAUSE_S}",
            "merge_para": f"{MERGE_PARA_MAX_CHARS}",
            "mastering": S2_SPECTRAL_CHAIN,
            "sampling": DEFAULT_SAMPLING,
            # How the decode runs. These change which kernels, CUDA-graph
            # shapes and streams a container owns, so a snapshot built with
            # different values is a different engine.
            "engine": ENGINE,
            "batch_max": BATCH,
            "fast_decode": int(FAST_DECODE),
            "codec_tuning": int(CODEC_TUNING),
            "kv_buckets": "-".join(str(v) for v in KV_BUCKETS),
            "bucket_batch": int(BUCKET_BATCH),
            "work_steal": int(WORK_STEAL),
            "eos_every": EOS_CHECK_EVERY,
            "sdpa_decode": int(SDPA_DECODE),
            "topk_fast": int(TOPK_FAST_SAMPLE),
            "dac_micro": DAC_MICRO_BATCH,
            "pipeline_codec": int(PIPELINE_CODEC),
            "audio_transport": transport_name(os.environ),
        }
    ),
    "S2C_VERSION": S2C_VERSION,
    "S2C_MAX_CONTAINERS": str(_LIMITS["max_containers"]),
    "S2C_LANES": str(_LIMITS["lanes"]),
    # Both the GPU class and the CPU probe resolve the registry from this, so a
    # staging deploy cannot read production's heartbeats.
    "S2C_HEARTBEAT_DICT": HEARTBEAT_DICT_NAME,
    # The engine is pinned into the container, not read from the ambient
    # environment at request time. Two reasons: a snapshot has to be built for
    # exactly the kernels it will run, and a runtime override that disagreed with
    # the snapshot would hand a restored container a decode path it never
    # compiled. `_BUILD_ENV` is applied to both the GPU class and the CPU probe,
    # so `/ready` describes the engine the containers are actually running.
    "S2C_ENGINE": ENGINE,
    # Reported so a staging A/B can prove the container really got more CPU;
    # Modal's own dashboard shows the same number, but a log line beats clicking.
    "S2C_CPU": str(os.environ.get("S2C_CPU", "4")),
}


def _max_containers() -> int:
    """Independent one-GPU containers.

    The baked default stays 1. A plain `modal deploy` therefore cannot open
    a fleet by itself. After deploy, the runbook sets the live cap with
    `update_autoscaler(max_containers=N)` where N is `MODAL_S2_MAX_GPUS`
    (default 20). `min_containers` stays 0. `@modal.concurrent(max_inputs=1)`
    sends a second book's call to another container instead of queueing it
    on this one; that decorator is in effect only after a redeploy.
    """
    return int(_LIMITS["max_containers"])


def max_batch_items(env=None) -> int:
    """Rows one `synthesize_batch` call may carry.

    Reported by `GET /ready` as `max_batch_items`. The worker only plans a page
    wider than its safe inline width when `/ready` reports both
    `audio_transport: "r2"` and this number at 32, so a worker deployed against
    the live 24-row container keeps sending at most 24 rows and never sees a 422
    `batch_too_large`.

    Never above `BATCH`: the KV cache is allocated for that many rows, and a
    row past it would index out of the cache.
    """
    env = os.environ if env is None else env
    try:
        value = int(str(env.get("S2C_MAX_BATCH_ITEMS", "")).strip())
    except (TypeError, ValueError):
        # Unset or malformed: the capacity, not a floor. A typo must not quietly
        # shrink every page to one row.
        return BATCH
    if value < 1:
        return BATCH
    return min(BATCH, value)


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
    .add_local_python_source(
        "s2_batch", "s2_mastering", "s2_contract", "s2_audio_store", copy=True
    )
)

#: Shared boot registry: one entry per container, written after restore.
print(
    f"[S2C] app={APP_NAME} heartbeat_dict={HEARTBEAT_DICT_NAME} "
    f"engine={ENGINE} version={S2C_VERSION} build={_BUILD_ENV['S2C_BUILD']}"
    + ("" if APP_NAME != "echomancer-s2-clone" else "  (PRODUCTION)")
)

heartbeats = modal.Dict.from_name(HEARTBEAT_DICT_NAME, create_if_missing=True)


def _section_units(text: str) -> list[dict]:
    """Split one section into paragraph units, the same way a book is split.

    `split_long_text` is total, so the size check below should never fire. It is
    kept as a cheap guard against a future regression in the splitter, but it
    **hard-slices** rather than raising: raising here answers 422 for the whole
    section, and the worker then drops it from the book. That is what happened to
    `job 1f0137a1` section 2 — 1,705 characters of a 17,023-character book
    vanished because one 318-char clause could not be split. A slightly awkward
    break inside one unit is always better than a missing section.
    """
    if len(text) > 60_000:
        raise ValueError("section is too large")
    units = make_units([t.strip() for t in text.split("\n\n") if t.strip()])
    fixed: list[dict] = []
    for unit in units:
        if len(unit["text"]) <= UNIT_MAX_CHARS:
            fixed.append(unit)
            continue
        # Should be unreachable. Break it here instead of losing the section.
        text_parts = split_long_text(unit["text"], hard_max=UNIT_MAX_CHARS)
        print(
            f"[S2C] unit of {len(unit['text'])} chars reached the guard; "
            f"sliced into {len(text_parts)} piece(s) instead of failing the section"
        )
        for piece, kind in text_parts:
            fixed.append({"text": piece, "pause": kind})
    return fixed


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


def _master_args(sample_rate: int, source: str) -> list[str]:
    """The ffmpeg arguments both mastering entry points share.

    Kept in one place so the pipe and file forms cannot drift: a changed filter
    or bitrate applied to one of them would make a section's bytes depend on
    which code path rendered it. `source` is the input spec — `pipe:0` for the
    piped path, a path for the file path.
    """
    return [
        "-hide_banner", "-nostdin", "-v", "error",
        "-f", "s16le", "-ar", str(sample_rate), "-ac", "1", "-i", source,
        "-af", S2_SPECTRAL_CHAIN,
        "-ar", str(SECTION_SAMPLE_RATE), "-ac", "1",
        "-c:a", "libmp3lame", "-b:a", SECTION_MP3_BITRATE,
        "-write_xing", "0",  # sections are copy-joined; no per-section TOC
    ]


def _master_pcm(pcm: bytes, sample_rate: int) -> bytes:
    """Master raw 16-bit PCM to MP3 bytes through a pipe."""
    result = subprocess.run(
        ["ffmpeg", *_master_args(sample_rate, "pipe:0"), "-f", "mp3", "pipe:1"],
        input=pcm,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    return result.stdout


def _master_bytes(samples, sample_rate: int) -> bytes:
    """Master one section and return the MP3 bytes, with no temporary file.

    The file version writes a `NamedTemporaryFile`, reopens it, reads it and
    unlinks it — per section, on the critical path. This pipes PCM in on
    stdin and reads MP3 out of stdout, so the same ffmpeg graph produces the
    same bytes with no disk round-trip. `test_s2_pipeline` asserts the two forms
    are byte-identical rather than trusting that claim.
    """
    return _master_pcm(_to_pcm16(samples), sample_rate)


def _to_pcm16(samples) -> bytes:
    """Float samples in [-1, 1] → little-endian 16-bit PCM.

    Exactly the conversion both mastering paths used inline, extracted so the
    pipeline converts once per section instead of once per encode attempt.
    """
    import numpy as np

    return (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()


class _PipelinedSection:
    """One section in flight through the encode/upload pipeline.

    A plain record rather than tuple indexes: the stages run on three different
    threads and a named hand-off is the difference between a readable pipeline
    and a scavenger hunt.
    """

    __slots__ = ("item_key", "units", "samples", "pcm", "encode", "upload", "mp3", "fields")

    def __init__(self, *, item_key: str, units: list) -> None:
        self.item_key = item_key
        self.units = units
        self.samples = 0
        self.pcm = b""
        self.encode = None
        self.upload = None
        self.mp3 = b""
        self.fields: dict = {}


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
    # CPU cores. The encode/upload pools are pure CPU work overlapped with the
    # GPU, so extra cores shorten a call's tail without touching the H100's cost
    # (four more cores are about $0.000052/s against $0.001097/s). Read at deploy
    # time, like every other sizing knob, and reported by `/ready` so a staging
    # A/B can prove it took effect.
    cpu=float(os.environ.get("S2C_CPU", "4")),
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
# One input per container. A second book's call is placed on another
# container (up to max_containers) instead of queueing on this GPU thread,
# which would answer 429. Needs a redeploy before it takes effect.
@modal.concurrent(max_inputs=1)
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
        # Prove the captured decode graphs survived the restore, **on the GPU
        # thread, before the first heartbeat**. A `cudaGraphExec_t` captured
        # before the snapshot is the one thing in this engine that a restore
        # could plausibly invalidate, and finding that out here costs a few
        # hundred milliseconds at boot; finding it out on a customer's first
        # section costs the section. The replay is the real compiled step, and a
        # failure is loud rather than silent — `_verify_graphs` re-raises.
        self.graph_check = "skipped"
        try:
            self.graph_check = self.gpu.submit(self._verify_graphs,
                                               timeout=float(os.environ.get("S2C_GRAPH_CHECK_S", "180")))
        except Exception as err:
            # A container that cannot replay its graphs is not serving this book:
            # refuse the boot so Modal replaces it instead of leaving a
            # half-working container in the pool.
            self.graph_check = "failed"
            print(f"[S2C] decode-graph verification FAILED: {type(err).__name__}: {err}")
            raise
        # Say plainly what is and is not known. A `boot=unknown` here is normal:
        # only a restore onto a younger host is provable from inside, and Modal's
        # own log line is the authoritative record either way.
        print(
            f"[S2C] container={self.container_id} build={_BUILD_ENV['S2C_BUILD']} "
            f"boot={kind} snapshot_age={self.snapshot_age_s}s "
            f"graphs={self.graph_check} "
            f"(restore duration is only measurable client-side)"
        )
        self._heartbeat(force=True)
        self._start_heartbeat_timer()

    def _verify_graphs(self) -> str:
        """Replay every warmed decode shape on the GPU thread. Raises on failure.

        `expected` is the size of the engine's own `(width, kv_len)` product — the
        same list the snapshot warmed — so a restore that invalidated any one of
        them is caught at boot. Comparing against the width count alone (the
        first version of this) would have passed while three quarters of the
        shapes were never replayed.
        """
        expected = len(self.engine.decode_shapes())
        stats = self.engine.selftest()
        replayed = int(stats.get("decode_shapes") or 0)
        if replayed != expected:
            raise RuntimeError(
                f"decode step replayed {replayed} shape(s), expected {expected}"
            )
        return f"ok({replayed})"


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
            "cpu": _BUILD_ENV["S2C_CPU"],
            "gpu_thread": self.gpu.thread_ident,
            "gpu_jobs": self.gpu.jobs_done,
            "calls": self.calls,
            "refs_cached": len(self.ref_cache),
            # The narration recipe this container would render with, so a
            # book's audio can be matched to the numbers behind it without
            # reading the container's image.
            "recipe": _RECIPE,
            "audio_transport": transport_name(os.environ),
            # How many rows one call may carry. The worker reads this to decide
            # whether a 32-row page is safe; a build without the field is 24.
            "max_batch_items": max_batch_items(),
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
                "x-s2-unit-chars": str(
                    (result.get("unit_shape") or {}).get("mean_chars") or 0
                ),
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

        Row contract. The app reads `audio_b64`, and also `storage_key`
        when this build uploaded the MP3 to R2:
            {"key", "audio_b64", "duration_s", "units", "truncated_units"}
            {"key", "storage_key", "audio_bytes", "duration_s", "units", "truncated_units"}
        or, for a section this call could not render:
            {"key", "error", "error_code"}
        A wide page uses the key. Inline base64 stays for a container
        with no R2 env, which is what an older build always returns.
        """
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

        max_items = max_batch_items()
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

        # ── the pipeline ───────────────────────────────────────────────────
        #
        # Stages used to run strictly one after another: every row generated,
        # then every row decoded, then every row encoded, then every MP3
        # uploaded. Each stage left the H100 idle. Here a finished section
        # leaves the GPU as soon as its codec decode is done:
        #
        #   s2-gpu thread      render (AR)  →  codec decode per section
        #   encode pool (CPU)              →  ffmpeg pipe:1 → MP3 bytes
        #   upload pool (CPU)              →  R2 PUT (pooled keep-alive)
        #
        # `on_section` is called with plain `np.ndarray`s on the GPU thread, so
        # nothing outside that thread ever touches a CUDA handle — the rule the
        # restored snapshot requires. `S2B_PIPELINE_CODEC=0` (the v9 default)
        # restores the serial order exactly, which is what makes a plain deploy
        # behave as the app does today.
        call_id = uuid.uuid4().hex
        job_id = str(payload.get("job_id") or "")
        sample_rate = self.engine.sample_rate
        encode_pool = ThreadPoolExecutor(
            max_workers=int(os.environ.get("S2C_ENCODE_WORKERS", "8")),
            thread_name_prefix="s2-mp3",
        )
        upload_pool = UploadPool(os.environ)
        #: One `_PipelinedSection` per section, indexed by section id, so the
        #: response can be built in item order however the sections finished.
        sections = [
            _PipelinedSection(item_key=key, units=units) for key, units in units_by_item
        ]
        pipeline = {"first_section_s": None, "encode_s": 0.0}

        def encode_section(
            section: int, unit_audio: list, *, assembled: bool = False
        ) -> None:
            """Runs on the GPU thread; only hands bytes to the CPU pools.

            Assembly and the 16-bit conversion touch no CUDA state, but they are
            cheap and they keep everything that reads a take on the thread that
            produced it. The moment the samples exist the encode is submitted,
            and the encode submits its own upload when ffmpeg returns — so a
            section's MP3 starts uploading without waiting for any other
            section.
            """
            record = sections[section]
            if assembled:
                # Already joined by `decode_slots`; running the assembly rules
                # again would add a second set of pauses.
                samples = _as_float_array(unit_audio[0]) if unit_audio else _as_float_array([])
            else:
                samples = assemble_slot_audio(record.units, unit_audio, sample_rate)
            record.samples = int(len(samples))
            record.pcm = _to_pcm16(samples)
            del samples
            if pipeline["first_section_s"] is None:
                pipeline["first_section_s"] = time.time() - t0

            def encode_and_upload() -> bytes:
                started = time.time()
                try:
                    mp3 = _master_pcm(record.pcm, sample_rate)
                finally:
                    # 16-bit PCM is ~21 MB for a four-minute section. It is not
                    # needed once ffmpeg has it, and holding a page of them
                    # until the call ends would double the peak memory for no
                    # benefit.
                    record.pcm = b""
                    pipeline["encode_s"] += time.time() - started
                record.upload = upload_pool.submit(
                    record.item_key, mp3, job_id, call_id
                )
                return mp3

            record.encode = encode_pool.submit(encode_and_upload)

        def gpu_work() -> dict:
            """Everything that touches CUDA or the codec, on the GPU thread.

            Reference encoding and every decode batch stay on this one thread,
            so no FastAPI worker thread ever opens a CUDA handle. The codec
            decode also happens here — it is CUDA — but it runs *during*
            generation for a section that has already finished, which is the
            overlap that removes the ~10 s codec phase from the call's wall.
            """
            ref, ref_key, ref_stats = self._resolve_reference(audio, ref_text)
            calls_seed = _apply_seed(seed_value)
            stats_all = {"frames": 0, "steps": 0, "truncated_units": 0}
            codes: list = []
            audio_by_section: dict[int, list] = {}
            truncated_by_slot: list[int] = []
            prepared_at = time.time()
            for start in range(0, len(slots), BATCH):
                chunk = slots[start : start + BATCH]

                def on_section(local: int, unit_audio: list, offset=start) -> None:
                    section = offset + local
                    audio_by_section[section] = unit_audio
                    encode_section(section, unit_audio)

                stats = self.engine.render(
                    chunk,
                    ref,
                    sampling_text,
                    on_section=on_section if PIPELINE_CODEC else None,
                )
                codes.extend(stats.pop("codes"))
                truncated_by_slot.extend(stats.pop("truncated_by_slot", []))
                for k in ("frames", "steps"):
                    stats_all[k] += stats.get(k, 0)
                # `loop_s` is the AR loop alone; the codec's wall is tracked
                # separately as `codec_s` / `codec_tail_s`. Keeping them apart is
                # what lets `generate_s` be reported without the codec, so an A/B
                # of the decode change shows up in the column it belongs to.
                stats_all["generate_loop_s"] = float(
                    stats_all.get("generate_loop_s") or 0
                ) + float(stats.get("loop_s") or 0)
                for k in ("codec_s", "codec_tail_s", "sections_streamed"):
                    if k in stats:
                        stats_all[k] = float(stats_all.get(k) or 0) + float(stats[k])
                # Per-call scalars, not sums: the widest page and the mode.
                for k in ("batch_width", "work_steal"):
                    if k in stats:
                        stats_all[k] = max(int(stats_all.get(k) or 0), int(stats[k]))
                stats_all["truncated_units"] += int(
                    stats.get("truncated_units") or 0
                )
            generated_at = time.time()
            # The serial path (v9) streams nothing, so every section lands here.
            # In v10 this only fires for a section the streaming callback did not
            # deliver, which must never cost the book a section.
            missing = [s for s in range(len(slots)) if s not in audio_by_section]
            if missing:
                # Safety net, not the normal path: an engine that returned
                # codes but did not stream a section for them (the serial
                # rollback, or a provider stub in a test). Decoding here keeps
                # a section from silently vanishing from the book, which is the
                # failure mode that matters most.
                subset = [codes[s] for s in missing]
                if any(c is not None for unit in subset for c in unit):
                    # `decode_slots` returns one **assembled** waveform per
                    # section (takes joined with their pauses). Handing that back
                    # to `encode_section` as a single unit would run the
                    # assembly again over one piece and keep the result, which is
                    # correct — but it also means the pauses must not be applied
                    # twice, so it goes through `take_assembled` rather than the
                    # per-unit path.
                    decoded = self.engine.decode_slots(subset, [slots[s] for s in missing])
                    for section, samples in zip(missing, decoded):
                        audio_by_section[section] = [samples]
                        encode_section(section, [samples], assembled=True)
            decoded_at = time.time()
            return {
                "ref_key": ref_key,
                "ref_stats": ref_stats,
                "seed": calls_seed,
                "stats": stats_all,
                "truncated_by_slot": truncated_by_slot,
                "sample_rate": sample_rate,
                "t_prepare": prepared_at,
                "t_gen": generated_at,
                "t_codec": decoded_at,
            }

        try:
            done = self._run_on_gpu(gpu_work)
        except GpuThreadBusy as err:
            encode_pool.shutdown(wait=False, cancel_futures=True)
            upload_pool.close()
            body, status = _error("lane_busy", str(err), 429)
            raise HTTPException(status_code=status, detail=body) from err
        except TimeoutError as err:
            encode_pool.shutdown(wait=False, cancel_futures=True)
            upload_pool.close()
            body, status = _error("boot_warming", str(err), 503)
            raise HTTPException(status_code=status, detail=body) from err
        except GpuThreadError as err:
            encode_pool.shutdown(wait=False, cancel_futures=True)
            upload_pool.close()
            body, status = _error("gpu_thread_unavailable", str(err), 503)
            raise HTTPException(status_code=status, detail=body) from err
        except (ReferenceClipError, ReferenceTextError) as err:
            encode_pool.shutdown(wait=False, cancel_futures=True)
            upload_pool.close()
            body, status = _error("reference_invalid", str(err), 422)
            raise HTTPException(status_code=status, detail=body) from err
        finally:
            pass

        # The GPU is done; only encode and upload remain. Both started while it
        # was still generating, so this wait is the short tail.
        try:
            for record in sections:
                record.mp3 = record.encode.result() if record.encode is not None else b""
            for record in sections:
                record.fields = (
                    record.upload.result()
                    if record.upload is not None
                    else {"key": record.item_key, "error_code": "encode_missing"}
                )
        finally:
            encode_pool.shutdown(wait=True)
            upload_pool.close()
        rows = []
        for i, record in enumerate(sections):
            rows.append({
                **record.fields,
                "duration_s": round(record.samples / sample_rate, 2),
                "units": len(record.units),
                "unit_shape": units_summary(record.units),
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
                # AR only. The codec's wall is a separate column, and on a v10
                # call it largely overlaps generation, so folding it in here
                # would make the decode change look like a regression.
                "generate_s": round(
                    float(done["stats"].get("generate_loop_s") or 0), 2
                ),
                # Everything from the end of prepare to the end of the codec:
                # AR plus codec, as a cross-check that the two columns add up.
                "generate_and_codec_s": round(done["t_codec"] - done["t_prepare"], 2),
                "codec_s": round(done["t_codec"] - done["t_gen"], 2),
                "encode_s": round(t_done - done["t_codec"], 2),
                "call_s": round(t_done - t0, 2),
                "pipeline": int(PIPELINE_CODEC),
                "first_section_s": (
                    round(pipeline["first_section_s"], 2)
                    if pipeline["first_section_s"] is not None
                    else None
                ),
                "codec_inline_s": round(float(done["stats"].get("codec_s") or 0), 2),
                "codec_tail_s": round(float(done["stats"].get("codec_tail_s") or 0), 2),
                "sections_streamed": int(done["stats"].get("sections_streamed") or 0),
                "batch_width": int(done["stats"].get("batch_width") or 0),
                "upload_transport": transport_name(os.environ),
                "upload_handshakes": upload_pool.handshakes,
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
            # Same clock split as /synthesize_batch. generate_s is the
            # semantic render, codec_s is the vocoder, master_s (below) is
            # the MP3. An earlier version stamped generate before render, so
            # codec_s was the render and master_s was vocoder plus MP3.
            prepared_at = time.time()
            stats = self.engine.render([units], ref, sampling_text)
            truncated_by_slot = stats.pop("truncated_by_slot", [])
            generated_at = time.time()
            samples = self.engine.decode_slots(stats.pop("codes"), [units])[0]
            coded_at = time.time()
            return {
                "ref_key": ref_key,
                "ref_stats": ref_stats,
                "seed": call_seed,
                "samples": samples,
                "truncated": int(sum(truncated_by_slot)),
                "sample_rate": self.engine.sample_rate,
                "t_prepare": prepared_at,
                "t_gen": generated_at,
                "t_codec": coded_at,
            }

        # Called directly (.remote()) this is already the owner thread, and
        # submitting from it would deadlock on the single-flight lock, so run
        # inline. Called from the HTTP handler it hops to the GPU thread.
        done = gpu_work() if self.gpu.owns_gpu() else self._run_on_gpu(gpu_work)

        samples = done["samples"]
        mp3 = _master_bytes(samples, done["sample_rate"])
        t_master = time.time()
        self._heartbeat()

        duration = len(samples) / done["sample_rate"]
        return {
            "audio_b64": base64.b64encode(mp3).decode(),
            "duration_s": round(duration, 2),
            "units": len(units),
            "unit_shape": units_summary(units),
            "truncated_units": done["truncated"],
            "prepare_s": round(done["t_prepare"] - t0, 2),
            "generate_s": round(done["t_gen"] - done["t_prepare"], 2),
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
    .add_local_python_source(
        "s2_batch", "s2_mastering", "s2_contract", "s2_audio_store"
    )
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
        "cpu": _BUILD_ENV["S2C_CPU"],
        "build": build,
        "version": S2C_VERSION,
        "heartbeat_ttl_s": HEARTBEAT_TTL_SECONDS,
        # Which narration recipe this build renders with. `build` alone is an
        # opaque hash, so a book's `x-s2-build` could not be tied to the unit
        # width it was made with. This is the mapping, reported without
        # starting a GPU.
        "recipe": _RECIPE,
        # `r2` means a wide batch uploads each MP3 and returns storage_key.
        # A build from before this field is what the worker treats as inline.
        "audio_transport": transport_name(os.environ),
        # How many rows one call may carry. The worker reads **this** endpoint to
        # decide whether a 32-row page is safe, and it reads it on the 503 (cold)
        # path as well as the 200: the page it plans next is chosen from what the
        # build can accept, not from whether a container happens to be warm. A
        # build without the field stays at the 24-row inline ceiling.
        "max_batch_items": max_batch_items(),
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
