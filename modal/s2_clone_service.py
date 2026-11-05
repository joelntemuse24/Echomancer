"""Production clone endpoint: one section in, one mastered MP3 out.

This is the HTTP face of the batched S2-Pro worker for the Echomancer clone
path. It replaces the Drama 3 call in `src/lib/tts/providers/openrouter-clone.ts`
without changing the section pipeline: the app still splits a book into
sections, streams section audio, masters it per section and joins the MP3s.

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
import time
import uuid

import modal
from fastapi import Request

from s2_batch import (
    BATCH,
    GPU,
    MAX_SEQ_LEN,
    UNIT_MAX_CHARS,
    _BatchEngine,
    gpu_image,
    make_units,
)
from s2_contract import (
    SamplingError,
    WARM_REFERENCE_TEXT,
    ReferenceClipError,
    ReferenceTextError,
    container_limits,
    parse_sampling,
    reference_stats,
    seed_for_call,
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
S2C_VERSION = os.environ.get("S2C_VERSION", "5")

#: Heartbeats older than this are treated as a dead container.
HEARTBEAT_TTL_SECONDS = int(os.environ.get("S2C_HEARTBEAT_TTL", "420"))
#: Rewrite a container's heartbeat at most this often (seconds).
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
        """Weights, compile and a real forward pass — all captured by the snapshot."""
        import torch

        self.boot_started = time.time()
        torch.cuda.init()
        self.engine = _BatchEngine()
        self.weights_loaded_at = time.time()
        # Two forward passes: text only, then with a reference. The second one
        # is the path every clone call takes, so its kernels and both prompt
        # shapes are compiled into the snapshot instead of the first customer's
        # section.
        self.engine.warm_up()
        self.compiled_at = time.time()
        # Customer material must never end up inside a snapshot, and a filled
        # KV cache is meaningless after restore. Drop both before the capture.
        self.engine.reset_state()
        self.ref_cache: dict[str, tuple] = {}
        self.transcripts: dict[str, str] = {}
        print(
            f"[S2C] build={_BUILD_ENV['S2C_BUILD']} "
            f"weights {self.weights_loaded_at - self.boot_started:.1f}s, "
            f"compile+warm {self.compiled_at - self.weights_loaded_at:.1f}s"
        )

    @modal.enter()
    def publish(self) -> None:
        """Runs on every container start, after a restore. Not snapshotted."""
        self.ready_at = time.time()
        self.container_id = os.environ.get("MODAL_CONTAINER_ID") or uuid.uuid4().hex[:12]
        self.calls = 0
        self._heartbeat_at = 0.0
        # A restored snapshot carries the snapshotting container's RNG state.
        # Reseed from the container, and every call reseeds again from its own
        # identity, so two containers never produce the same take.
        _apply_seed(seed_for_call(self.container_id, "boot", int(self.ready_at)))
        restored = self.ready_at - self.compiled_at
        self.restored_s = round(restored, 1)
        print(
            f"[S2C] container={self.container_id} build={_BUILD_ENV['S2C_BUILD']} "
            f"ready {restored:.1f}s after snapshot mark "
            f"({'restored snapshot' if restored < 60 else 'built snapshot here'})"
        )
        self._heartbeat(force=True)

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
                "at": int(now),
                "restored_s": self.restored_s,
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
            "restored_s": self.restored_s,
            "calls": self.calls,
            "refs_cached": len(self.ref_cache),
        }

    def _resolve_reference(self, audio: bytes, ref_text: str) -> tuple[tuple, str, dict]:
        """Encode the clip once per container, transcribe once when needed."""
        stats = reference_stats(audio)
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
            )
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
            ref, ref_key, ref_stats = self._resolve_reference(audio, ref_text)
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
        t_prepare = time.time()
        seed = _apply_seed(
            payload.get("seed")
            if payload.get("seed") not in (None, "")
            else seed_for_call(
                payload.get("job_id"),
                ",".join(keys),
                int(payload.get("seed_epoch") or 0),
            )
        )
        self.calls += 1
        # One batch row per section. More sections than rows would be clamped,
        # which silently drops work, so cap the page size instead.
        stats_all = {"frames": 0, "steps": 0, "truncated_units": 0}
        codes: list = []
        truncated_by_slot: list[int] = []
        for start in range(0, len(slots), BATCH):
            stats = self.engine.render(
                slots[start : start + BATCH],
                ref,
                f"{sampling[0]},{sampling[1]}",
            )
            codes.extend(stats.pop("codes"))
            truncated_by_slot.extend(stats.pop("truncated_by_slot", []))
            for k in ("frames", "steps"):
                stats_all[k] += stats.get(k, 0)
            stats_all["truncated_units"] += int(stats.get("truncated_units") or 0)
        stats = stats_all
        t_gen = time.time()
        if codes:
            rendered = self.engine.decode_slots(codes, slots)
        else:
            rendered = []
        t_codec = time.time()

        # ffmpeg is one process per section; running them in parallel turns
        # ~7 s of per-call encode into ~2 s on a 4-CPU container.
        def encode(samples) -> bytes:
            with tempfile.NamedTemporaryFile(suffix=".mp3") as f:
                _master(samples, self.engine.sample_rate, f.name)
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
                "duration_s": round(len(samples) / self.engine.sample_rate, 2),
                "units": len(units),
                "truncated_units": (
                    int(truncated_by_slot[i]) if i < len(truncated_by_slot) else 0
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
            "seed": seed,
            "sampling": f"{sampling[0]},{sampling[1]}",
            "reference": {
                "sha256": ref_key,
                "seconds": ref_stats.get("seconds"),
                "rms": ref_stats.get("rms"),
            },
            "performance": {
                "sections": len(slots),
                "audio_s": round(sum(r.get("duration_s", 0) for r in rows), 1),
                "prepare_s": round(t_prepare - t0, 2),
                "generate_s": round(t_gen - t_prepare, 2),
                "codec_s": round(t_codec - t_gen, 2),
                "encode_s": round(t_done - t_codec, 2),
                "call_s": round(t_done - t0, 2),
                "truncated_units": stats_all["truncated_units"],
                "restored_s": self.restored_s,
                **{k: stats[k] for k in ("frames", "frames_per_s", "generated_realtime_x") if k in stats},
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
        """Benchmark/CLI entrypoint; the HTTP endpoint calls the same code."""
        return self._synthesize_section(text, ref_b64, ref_text, sampling, seed)

    def _synthesize_section(
        self,
        text: str,
        ref_b64: str,
        ref_text: str,
        sampling: str,
        seed=None,
        job_id: str | None = None,
    ) -> dict:
        import tempfile

        t0 = time.time()
        units = _section_units(text)
        if not units:
            raise ValueError("section has no speakable text")

        audio = base64.b64decode(ref_b64)
        validate_reference_audio(audio)
        ref, ref_key, ref_stats = self._resolve_reference(audio, ref_text)
        temperature, top_p = parse_sampling(sampling, DEFAULT_SAMPLING)
        sampling_text = f"{temperature},{top_p}"

        self.calls += 1
        call_seed = _apply_seed(
            seed if seed not in (None, "") else seed_for_call(job_id, text[:64], 0)
        )
        stats = self.engine.render([units], ref, sampling_text)
        truncated_by_slot = stats.pop("truncated_by_slot", [])
        t_gen = time.time()
        samples = self.engine.decode_slots(stats.pop("codes"), [units])[0]
        t_codec = time.time()

        with tempfile.NamedTemporaryFile(suffix=".mp3") as f:
            _master(samples, self.engine.sample_rate, f.name)
            with open(f.name, "rb") as fh:
                mp3 = fh.read()
        t_master = time.time()
        self._heartbeat()

        duration = len(samples) / self.engine.sample_rate
        return {
            "audio_b64": base64.b64encode(mp3).decode(),
            "duration_s": round(duration, 2),
            "units": len(units),
            "truncated_units": int(sum(truncated_by_slot)),
            "generate_s": round(t_gen - t0, 2),
            "codec_s": round(t_codec - t_gen, 2),
            "master_s": round(t_master - t_codec, 2),
            "call_s": round(t_master - t0, 2),
            "realtime_x": round(duration / max(t_master - t0, 1e-6), 1),
            "since_warm_s": round(time.time() - self.ready_at, 1),
            "restored_s": self.restored_s,
            "seed": call_seed,
            "sampling": sampling_text,
            "build": _BUILD_ENV["S2C_BUILD"],
            "container_id": self.container_id,
            "reference": {"sha256": ref_key, "seconds": ref_stats.get("seconds")},
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


def _live_containers(build: str) -> list[dict]:
    """Containers that finished restoring this build and are still in window."""
    now = time.time()
    out: list[dict] = []
    stale: list[str] = []
    try:
        for key, value in heartbeats.items():
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
            heartbeats.pop(key, None)
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
                "restored_s": row.get("restored_s"),
                "calls": row.get("calls"),
            }
            for row in live[:8]
        ],
    }
    if not live:
        return JSONResponse(payload, status_code=503)
    return payload
