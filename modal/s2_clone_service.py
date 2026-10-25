"""Production clone endpoint: one section in, one mastered MP3 out.

This is the HTTP face of the batched S2-Pro worker for the Echomancer clone
path. It replaces the Drama 3 call in `src/lib/tts/providers/openrouter-clone.ts`
without changing the section pipeline: the app still splits a book into
sections, streams section audio, masters it per section and joins the MP3s.

    POST /synthesize
    {"text": "...", "reference_audio_base64": "...", "reference_text": "...",
     "sampling": "0.9,0.9", "job_id": "..."}
    -> audio/mpeg (mastered), or JSON error

Units: the text is split the way the batch pipeline splits a book (whole
paragraphs, ~400 chars, never inside a sentence). All units go through ONE
slot, so each unit hears the previous one and the section keeps its pace.

The mastering chain is `s2_mastering.S2_SPECTRAL_CHAIN`; loudness is left to
the app's per-section pass so a book is not normalised twice.

Deploy (keeps the container warm between sections):

    modal deploy modal/s2_clone_service.py
    modal run modal/s2_clone_warm.py          # builds the snapshot BEFORE real traffic

Every deploy invalidates the snapshot, and a rebuild takes ~15 min. Modal's
web proxy drops a request after ~542 s, so an HTTP call cannot build the first
snapshot: it fails with 502 and the container is killed mid-compile, leaving
nothing behind. Warm it over the client RPC (no proxy limit) instead.
`S2C_VERSION` must be bumped when methods are added, or a restored snapshot
can lack them and fail with KeyError.

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
from s2_mastering import S2_SPECTRAL_CHAIN, SECTION_MP3_BITRATE, SECTION_SAMPLE_RATE

APP_NAME = "echomancer-s2-clone"
# Clone requests are small and latency-sensitive: keep one warm rather than
# paying a 20 s restore per section.
SCALEDOWN_WINDOW = int(os.environ.get("S2C_SCALEDOWN", "300"))
DEFAULT_SAMPLING = os.environ.get("S2C_SAMPLING", "0.9,0.9")

app = modal.App(APP_NAME)

# Modal mounts only the entrypoint file by default, so the modules this app
# imports must be added explicitly or the container fails at import time.
# FastAPI is also required for the web endpoint. Both are layered on top so the
# batch app's image, and its snapshots, stay untouched.
web_image = (
    gpu_image.pip_install("fastapi[standard]==0.115.6")
    .add_local_python_source("s2_batch", "s2_mastering", copy=True)
)


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
    scaledown_window=SCALEDOWN_WINDOW,
    # The first call on a fresh deployment also builds the snapshot, which can
    # take 15+ minutes; a 900 s cap killed that request mid-compile.
    timeout=int(os.environ.get("S2C_TIMEOUT", "3600")),
    max_containers=int(os.environ.get("S2C_MAX_CONTAINERS", "4")),
    enable_memory_snapshot=True,
    experimental_options={"enable_gpu_snapshot": True},
    env={
        "S2B_GPU": GPU,
        "S2B_BATCH": str(BATCH),
        "S2B_MAX_SEQ_LEN": str(MAX_SEQ_LEN),
        # Bump when methods are added: a restored snapshot does not always
        # pick up new code, and a stale one fails with KeyError(method).
        "S2C_VERSION": os.environ.get("S2C_VERSION", "3"),
    },
)
class S2CloneWorker:
    @modal.enter(snap=True)
    def load(self) -> None:
        import torch

        self.boot_started = time.time()
        torch.cuda.init()
        self.engine = _BatchEngine()
        self.weights_loaded_at = time.time()
        self.engine.warm_up()
        self.compiled_at = time.time()
        self.ref_cache: dict[str, tuple] = {}
        self.transcripts: dict[str, str] = {}
        print(
            f"[S2C] weights {self.weights_loaded_at - self.boot_started:.1f}s, "
            f"compile+warm {self.compiled_at - self.weights_loaded_at:.1f}s"
        )

    @modal.enter()
    def publish(self) -> None:
        self.ready_at = time.time()

    # The endpoint lives on the class so the request is handled by the container
    # that already holds the model. A separate function calling .remote() adds a
    # hop whose own timeout can kill a long first call.
    @modal.fastapi_endpoint(method="POST", docs=False)
    def synthesize(self, payload: dict, request: Request):
        """One section in, one mastered MP3 out."""
        import base64

        from fastapi import HTTPException
        from fastapi.responses import JSONResponse, Response

        expected = os.environ.get("MODAL_S2_TOKEN", "").strip()
        if not expected or request.headers.get("x-echomancer-token") != expected:
            raise HTTPException(status_code=401, detail="unauthorized")

        text = (payload.get("text") or "").strip()
        ref_b64 = payload.get("reference_audio_base64") or ""
        ref_text = (payload.get("reference_text") or "").strip()
        if not text or not ref_b64:
            raise HTTPException(
                status_code=400, detail="text and reference_audio_base64 are required"
            )
        try:
            result = self._synthesize_section(
                text, ref_b64, ref_text, payload.get("sampling") or ""
            )
        except ValueError as err:
            raise HTTPException(status_code=422, detail=str(err)) from err

        if payload.get("json"):
            return JSONResponse(result)
        return Response(
            base64.b64decode(result["audio_b64"]),
            media_type="audio/mpeg",
            headers={
                "x-s2-duration": str(result["duration_s"]),
                "x-s2-call-ms": str(int(result["call_s"] * 1000)),
                "x-s2-units": str(result["units"]),
            },
        )

    @modal.fastapi_endpoint(method="POST", docs=False)
    def synthesize_batch(self, payload: dict, request: Request):
        """Many sections in one call; one batch row per section.

        Each section is its own row, so every row hears only the reference and
        keeps its own rhythm. Batching across sections is what makes the GPU
        worth its price: rows share each weight read.
        """
        import base64
        import hashlib
        import tempfile

        from fastapi import HTTPException
        from fastapi.responses import JSONResponse

        expected = os.environ.get("MODAL_S2_TOKEN", "").strip()
        if not expected or request.headers.get("x-echomancer-token") != expected:
            raise HTTPException(status_code=401, detail="unauthorized")

        items = payload.get("items") or []
        ref_b64 = payload.get("reference_audio_base64") or ""
        ref_text = (payload.get("reference_text") or "").strip()
        if not items or not ref_b64:
            raise HTTPException(
                status_code=400, detail="items and reference_audio_base64 are required"
            )
        max_items = int(os.environ.get("S2C_MAX_BATCH_ITEMS", "24"))
        if len(items) > max_items:
            raise HTTPException(
                status_code=422,
                detail=f"{len(items)} sections > {max_items} per call; send fewer",
            )

        t0 = time.time()
        audio = base64.b64decode(ref_b64)
        key = hashlib.sha256(audio).hexdigest()
        if key not in self.ref_cache:
            self.ref_cache[key] = self.engine.encode_reference(audio)
        if not ref_text:
            if key not in self.transcripts:
                self.transcripts[key] = self.engine.transcribe_reference(audio)
            ref_text = self.transcripts[key]
        if not ref_text.strip():
            raise HTTPException(
                status_code=422, detail="reference transcript is empty"
            )

        # One slot per section. Sections that do not fit become their own call.
        units_by_item, errors = [], {}
        for item in items:
            try:
                units = _section_units(item.get("text") or "")
                if not units:
                    raise ValueError("no speakable text")
                units_by_item.append((item["key"], units))
            except ValueError as err:
                errors[item["key"]] = str(err)

        slots = [units for _, units in units_by_item]
        t_prepare = time.time()
        # One batch row per section. More sections than rows would be clamped,
        # which silently drops work, so cap the page size instead.
        stats_all = {"frames": 0, "steps": 0}
        codes: list = []
        for start in range(0, len(slots), BATCH):
            stats = self.engine.render(
                slots[start : start + BATCH],
                (self.ref_cache[key], ref_text),
                payload.get("sampling") or DEFAULT_SAMPLING,
            )
            codes.extend(stats.pop("codes"))
            for k in ("frames", "steps"):
                stats_all[k] += stats.get(k, 0)
        stats = stats_all
        t_gen = time.time()
        rendered = self.engine.decode_slots(codes, slots)
        t_codec = time.time()

        # ffmpeg is one process per section; running them in parallel turns
        # ~7 s of per-call encode into ~2 s on a 4-CPU container.
        from concurrent.futures import ThreadPoolExecutor

        def encode(samples) -> bytes:
            with tempfile.NamedTemporaryFile(suffix=".mp3") as f:
                _master(samples, self.engine.sample_rate, f.name)
                with open(f.name, "rb") as fh:
                    return fh.read()

        with ThreadPoolExecutor(4) as pool:
            mp3s = list(pool.map(encode, rendered))

        rows = []
        for (item_key, units), samples, mp3 in zip(units_by_item, rendered, mp3s):
            rows.append({
                "key": item_key,
                "audio_b64": base64.b64encode(mp3).decode(),
                "duration_s": round(len(samples) / self.engine.sample_rate, 2),
                "units": len(units),
            })
        for item_key, message in errors.items():
            rows.append({"key": item_key, "error": message})
        t_done = time.time()

        return JSONResponse({
            "items": rows,
            "performance": {
                "sections": len(slots),
                "audio_s": round(sum(r.get("duration_s", 0) for r in rows), 1),
                "prepare_s": round(t_prepare - t0, 2),
                "generate_s": round(t_gen - t_prepare, 2),
                "codec_s": round(t_codec - t_gen, 2),
                "encode_s": round(t_done - t_codec, 2),
                "call_s": round(t_done - t0, 2),
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
    ) -> dict:
        """Benchmark/CLI entrypoint; the HTTP endpoint calls the same code."""
        return self._synthesize_section(text, ref_b64, ref_text, sampling)

    def _synthesize_section(
        self,
        text: str,
        ref_b64: str,
        ref_text: str,
        sampling: str,
    ) -> dict:
        import tempfile

        t0 = time.time()
        units = _section_units(text)
        if not units:
            raise ValueError("section has no speakable text")

        audio = base64.b64decode(ref_b64)
        key = hashlib.sha256(audio).hexdigest()
        if key not in self.ref_cache:
            self.ref_cache[key] = self.engine.encode_reference(audio)
        # Rows cloned before the transcript column existed send an empty string.
        # Transcribe once per reference rather than reuse a prompt the model drops.
        if not ref_text:
            if key not in self.transcripts:
                self.transcripts[key] = self.engine.transcribe_reference(audio)
            ref_text = self.transcripts[key]
        if not ref_text.strip():
            raise ValueError("reference transcript is empty; cloning would be ignored")
        ref = (self.ref_cache[key], ref_text)

        stats = self.engine.render([units], ref, sampling or DEFAULT_SAMPLING)
        t_gen = time.time()
        samples = self.engine.decode_slots(stats.pop("codes"), [units])[0]
        t_codec = time.time()

        with tempfile.NamedTemporaryFile(suffix=".mp3") as f:
            _master(samples, self.engine.sample_rate, f.name)
            with open(f.name, "rb") as fh:
                mp3 = fh.read()
        t_master = time.time()

        duration = len(samples) / self.engine.sample_rate
        return {
            "audio_b64": base64.b64encode(mp3).decode(),
            "duration_s": round(duration, 2),
            "units": len(units),
            "generate_s": round(t_gen - t0, 2),
            "codec_s": round(t_codec - t_gen, 2),
            "master_s": round(t_master - t_codec, 2),
            "call_s": round(t_master - t0, 2),
            "realtime_x": round(duration / max(t_master - t0, 1e-6), 1),
            "since_warm_s": round(self.ready_at - self.compiled_at, 1),
            "sampling": sampling or DEFAULT_SAMPLING,
        }





