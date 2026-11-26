"""Drew, Walter, George, and Heart on Modal CPU.

Runtime (Nov 2026). ``KOKORO_RUNTIME`` is read at deploy time:

* ``torch`` (default): the previous runtime (one call per container,
  ``memory=6144``). A plain ``modal deploy`` stays here.
* ``onnx``: ONNX Runtime fp32, no torch in the serving process. Set
  ``KOKORO_RUNTIME=onnx`` at deploy. One container serves ``KOKORO_STREAMS``
  (4) calls at once, one ORT thread each, on ``cpu=2`` (4 vCPU) and one
  shared copy of the weights. Memory defaults to 6144 MB. The measured
  peak with 4 concurrent Drew sections is 5.0–5.9 GB; Modal ``memory=`` is
  a request, not an OOM guard (``ONNX_MEMORY_MB``). Drew's graph is exported once into
  his volume: ``modal run modal/sowell_worker.py::export_drew_onnx``.
  Prosody G is a torch hook and is refused here (the worker's default is
  off, ``DREW_PROSODY_RULES``).

Mastering. A request may carry ``master`` (the recipe the worker builds in
``src/lib/tts/kokoro-master.ts``). The container then returns the podcast-
chain MP3 and the raw WAV in one body, and the worker publishes the section
without an ``echomancer-cpu`` task. A failed pass returns the plain WAV and
the worker masters it as before.

The text below describes the torch runtime where it differs.

A separate app from echomancer-cpu and echomancer-s2-clone. It is the same
`echomancer-sowell` app the Walter/George voices already ship from: Renaming
Walter is a copy change, Drew is a second resident model on that app, and
Heart is the stock `af_heart` pack on the same base model as George. None
of them is a separate fleet.

    modal deploy modal/sowell_worker.py

Each container loads stock Kokoro once in ``@modal.enter`` and reuses that
runtime until idle scale-down. ``min_containers`` is 0. One request at a
time per container, because the model is not reentrant. A second request
gets 429 so the caller can use another container in the fleet.

Fleet. ``SOWELL_MAX_CONTAINERS`` (default 16, clamped to 1..16) is the cap.
The worker's ``SOWELL_BOOK_LANES`` (also default 16, clamped to 16 and to the
fleet) is how many of those one book may hold; the ``kokoro`` provider-slot
rows are the cross-process share, so several books cannot open more calls than
the fleet. A book alone gets the whole fleet; concurrent books split it so the
quotas sum to the fleet and a new book takes lanes as other books' sections
finish. Containers keep ``memory=6144`` each: lanes are containers, not extra
memory.

Sections. The worker packs a Kokoro-CPU book at ``KOKORO_CPU_SECTION_CHARS``
(default 700, clamped 300..2000), with a shorter first section so first audio
arrives fast. Each section is one call to whichever container holds a lane,
so a smaller target shortens the tail. The container still caps a request at
``MAX_CHARS`` (2,000) and splits internally at 510 phonemes.

Idle. ``SOWELL_SCALEDOWN_SECONDS`` is 5, clamped to Modal's 2..1200. The idle
tail dominated the measured book's cost: 16 lanes x 700-char sections finished
the 15.7k-character text in 47 s against 74 s for 6 lanes x 1.4k, so the fleet
is bigger and a container's work is shorter. That leaves a 5 s idle keeping
the cost about equal while the next section of a book still arrives in
seconds.

Memory. Walter and George share one stock kmodel (~330 MB). Drew is a
different kmodel of its own (~313 MB), so the ceiling moved 4 GB → 6 GB.
That is per container and does not grow with the lane count: sixteen lanes
are sixteen containers of the same size.

Threads. Modal ``cpu=2`` is two physical cores, four hardware threads.
Torch gets ``SOWELL_TORCH_THREADS`` (default 4) via ``torch.set_num_threads``
in ``@modal.enter``, before the first model load.
``SOWELL_TORCH_INTEROP_THREADS`` (default 1) does the same for inter-op. Both
are read once per container, so changing them needs a redeploy.

The default is 4 because it was measured on this image
(``modal/sowell_bench.py``, Drew, cpu=2, two rounds x 2 repeats). The
719-character harbor paragraph is 39.7 s of audio: 2 threads took 25.3-27.1 s
wall (RTF 1.46-1.57), 4 threads took 16.5-19.3 s (RTF 2.06-2.41) — about
1.5x faster at the same container cost.

Volumes. Drew's weights are private and are not in the image. They come from
the ``andrew-distill`` volume, default mount ``/andrew-distill``:

    /kokoro/retrain_v3/stageA/step00900_kmodel.pth
    /kokoro/retrain_v3/stageA/step00900_voice.pt

``DREW_VOLUME_NAME`` and ``DREW_VOLUME_MOUNT`` override both. A container
that has not been given the volume still serves Walter and George; only Drew
answers 503 ``DREW_UNAVAILABLE``. That is what keeps a missing upload from
taking the other narrators down with it.

Secret ``echomancer-sowell``: ``SOWELL_TOKEN``. ``DREW_TOKEN`` may hold the
same value; the handler accepts either.
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import modal
from fastapi import Request

APP_NAME = os.environ.get("SOWELL_APP_NAME", "echomancer-sowell")
_ROOT = Path(__file__).resolve().parents[1]
image = modal.Image.from_dockerfile(
    _ROOT / "workers" / "sowell" / "Dockerfile",
    context_dir=_ROOT,
).pip_install("fastapi[standard]==0.115.6")

DREW_VOLUME_NAME = os.environ.get("DREW_VOLUME_NAME", "andrew-distill")
DREW_VOLUME_MOUNT = os.environ.get("DREW_VOLUME_MOUNT", "/andrew-distill")

#: Deploy-time runtime choice, baked into the container env below.
RUNTIMES = ("onnx", "torch")


def kokoro_runtime(env: dict | None = None) -> str:
    raw = str((env or os.environ).get("KOKORO_RUNTIME", "torch")).strip().lower()
    return raw if raw in RUNTIMES else "torch"


RUNTIME = kokoro_runtime()
#: Calls one ONNX container serves at once (one ORT thread each, cpu=2).
STREAMS_DEFAULT = 4
STREAMS_CEILING = 8


def kokoro_streams(env: dict | None = None) -> int:
    """Concurrent calls per container: 1 on torch, ``KOKORO_STREAMS`` (4) on ONNX."""
    env = env or os.environ
    if kokoro_runtime(env) == "torch":
        return 1
    try:
        n = int(str(env.get("KOKORO_STREAMS", STREAMS_DEFAULT)).strip())
    except (TypeError, ValueError):
        n = STREAMS_DEFAULT
    return max(1, min(STREAMS_CEILING, n))


STREAMS = kokoro_streams()
#: Torch runtime memory: stock + Drew kmodels on the old image.
TORCH_MEMORY_MB = 6144
#: Measured peak with 4 concurrent Drew sections is 5.9 GB, 5.0 GB with
#: ``enable_mem_pattern=False`` and arena ``kSameAsRequested``. 6144 is that
#: peak plus headroom. Modal ``memory=`` is a scheduling request, not an OOM
#: guard. Overridable at deploy with ``ONNX_MEMORY_MB``.
ONNX_MEMORY_MB_DEFAULT = 6144


def memory_mb(env: dict | None = None) -> int:
    env = env or os.environ
    if kokoro_runtime(env) == "torch":
        return TORCH_MEMORY_MB
    try:
        n = int(str(env.get("ONNX_MEMORY_MB", ONNX_MEMORY_MB_DEFAULT)).strip())
    except (TypeError, ValueError):
        n = ONNX_MEMORY_MB_DEFAULT
    return max(1536, min(TORCH_MEMORY_MB, n))


_BAKED_ENV = {"KOKORO_RUNTIME": RUNTIME, "KOKORO_STREAMS": str(STREAMS)}
# A test deploy points Drew's export at its own volume. Production leaves this unset.
if os.environ.get("DREW_ONNX_DIR", "").strip():
    _BAKED_ENV["DREW_ONNX_DIR"] = os.environ["DREW_ONNX_DIR"].strip()
image = image.env(_BAKED_ENV)

app = modal.App(APP_NAME)
MAX_CHARS = 2000
#: Torch intra-op threads. Read once per container in `@modal.enter`, before
#: the first model load. Default 4: benchmarked ~1.5x faster than 2 on cpu=2
#: (RTF 2.06-2.41 vs 1.46-1.57). `modal/sowell_bench.py` re-measures it.
TORCH_THREADS = os.environ.get("SOWELL_TORCH_THREADS", "4")
PACK = os.environ.get("SOWELL_PACK", "/opt/sowell/voices/am_sowell_avg.pt")
MANIFEST = os.environ.get("SOWELL_MANIFEST", "/opt/sowell/voices/manifest.json")

#: Fleet ceiling. `SOWELL_MAX_CONTAINERS` is read at deploy time, clamped to
#: 1..16 so a typo cannot ask Modal for a roster this app was not sized for.
#: The worker's `SOWELL_FLEET_CONTAINERS_CEILING` is the same number.
MAX_CONTAINERS_CEILING = 16
MAX_CONTAINERS_DEFAULT = 16

#: Modal's allowed `scaledown_window` range, in seconds.
SCALEDOWN_MIN = 2
SCALEDOWN_MAX = 1200
#: 5 s of idle. The measured book left the idle tail as the dominant cost, so
#: a container that is done should go away instead of holding a lane.
SCALEDOWN_DEFAULT = 5


def max_containers(env: dict | None = None) -> int:
    """Deploy-time `max_containers`. Default 16, clamped to 1..16.

    The number is containers, on both runtimes. ONNX serves
    ``KOKORO_STREAMS`` (4) calls in each one, so 12 containers are 48 calls
    and 16 containers are 64. Dividing the call cap by the stream count
    left ONNX at 4 containers, which was slower than today's torch fleet.
    """
    env = env or os.environ
    raw = env.get("SOWELL_MAX_CONTAINERS", "")
    try:
        n = int(str(raw).strip())
    except (TypeError, ValueError):
        n = MAX_CONTAINERS_DEFAULT
    return max(1, min(MAX_CONTAINERS_CEILING, n))


def scaledown_seconds(env: dict | None = None) -> int:
    """Deploy-time `scaledown_window`, clamped to Modal's 2..1200. Default 5."""
    raw = (env or os.environ).get("SOWELL_SCALEDOWN_SECONDS", "")
    try:
        n = int(str(raw).strip())
    except (TypeError, ValueError):
        n = SCALEDOWN_DEFAULT
    return max(SCALEDOWN_MIN, min(SCALEDOWN_MAX, n))

drew_volume = modal.Volume.from_name(DREW_VOLUME_NAME, create_if_missing=True)
#: Same string as `KOKORO_BUNDLE_CONTENT_TYPE` in src/lib/tts/kokoro-master.ts.
KOKORO_BUNDLE_CONTENT_TYPE = "application/x-echomancer-kokoro-bundle"


def process_high_water_mb() -> float:
    """Peak RSS of this process, in MiB.

    Modal's sandbox does not publish ``VmHWM`` in ``/proc/self/status``.
    ``ru_maxrss`` is kilobytes on Linux, which is the image this runs in.
    """
    try:
        import resource

        rss_kb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        if rss_kb > 0:
            return rss_kb / 1024
    except (OSError, ValueError, AttributeError):
        pass
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith("VmHWM:"):
                kb = int(line.split()[1])
                if kb > 0:
                    return kb / 1024
    except (OSError, ValueError, IndexError):
        return 0.0
    return 0.0


def cgroup_peak_mb() -> float | None:
    """Container cgroup peak, in MiB.

    The header is optional. Modal's sandbox has neither cgroup file, so the
    fallback is this process's RSS peak. None only when that is also missing.
    """
    for path in (
        "/sys/fs/cgroup/memory.peak",
        "/sys/fs/cgroup/memory/memory.max_usage_in_bytes",
    ):
        try:
            raw = Path(path).read_text().strip()
        except OSError:
            continue
        if raw.isdigit() and int(raw) > 0:
            return int(raw) / (1024 * 1024)
    rss = process_high_water_mb()
    return rss if rss > 0 else None


SOWELL_SECRET_NAME = os.environ.get("SOWELL_SECRET_NAME", "echomancer-sowell")


def _authorized(request: Request) -> bool:
    presented = request.headers.get("authorization", "")
    for name in ("SOWELL_TOKEN", "DREW_TOKEN"):
        expected = os.environ.get(name, "")
        if expected and presented == f"Bearer {expected}":
            return True
    return False


@app.cls(
    image=image,
    cpu=2,
    memory=memory_mb(),
    timeout=180,
    min_containers=0,
    max_containers=max_containers(),
    scaledown_window=scaledown_seconds(),
    # The model load is the cold start. A memory snapshot restores it instead
    # of reading the checkpoint again. The gate lock is created after restore:
    # a lock captured in the snapshot is tied to the process that took it.
    enable_memory_snapshot=True,
    secrets=[modal.Secret.from_name(SOWELL_SECRET_NAME)],
    volumes={DREW_VOLUME_MOUNT: drew_volume},
)
@modal.concurrent(max_inputs=STREAMS)
class Speaker:
    @modal.enter(snap=True)
    def load(self) -> None:
        sys.path.insert(0, "/opt/sowell/scripts")
        self.runtime = kokoro_runtime()
        self._snap_mono = time.monotonic()
        if self.runtime == "onnx":
            from onnx_engine import OnnxEngine

            self.engine = OnnxEngine()
            # Packs and G2P only. ORT sessions, their thread pools, and the
            # engine locks are created in `open_gate` after a restore.
            self.engine.load_assets()
            return
        from engine import apply_torch_threads, SowellEngine

        # Before the first model load: torch reads the pool size lazily, but a
        # loaded model can already have started it. Named separately from
        # `SOWELL_CPU_THREADS` so a benchmark can vary it per call.
        self.threads = apply_torch_threads()

        self.engine = SowellEngine()
        self.engine.load(Path(PACK), Path(MANIFEST))
        # Drew is the default narrator, so load it here too when its volume is
        # present: the first Drew section must not pay a disk read. A missing
        # volume is reported and left alone — Walter and George still work.
        if not self.engine.load_drew():
            print(
                "[drew] weights unavailable at boot; the next Drew request loads them",
                flush=True,
            )

    @modal.enter()
    def open_gate(self) -> None:
        # One permit per stream: 1 on torch, KOKORO_STREAMS on ONNX.
        # A restored snapshot's monotonic clock is younger than the clock
        # frozen inside `load`, which is how a container can prove a restore.
        snap = getattr(self, "_snap_mono", None)
        now = time.monotonic()
        self.boot = "restored" if isinstance(snap, float) and now + 0.5 < snap else "unknown"
        self.gate = threading.BoundedSemaphore(kokoro_streams())
        if self.runtime == "onnx":
            self.engine.open_sessions()
            if not self.engine.ensure_drew():
                print(
                    "[drew] ONNX export not loaded at boot; the next Drew request "
                    "loads it if the export is on the volume: "
                    + str(self.engine.drew_error),
                    flush=True,
                )
        print(f"[kokoro] boot={self.boot} runtime={self.runtime}", flush=True)

    def _ensure_drew(self) -> bool:
        """Load Drew now. A snapshot that missed the export tries again."""
        if self.runtime == "onnx":
            return bool(self.engine.ensure_drew())
        return bool(self.engine.load_drew())

    @modal.fastapi_endpoint(method="POST", docs=False)
    def speak(self, item: dict, request: Request):
        from fastapi.responses import JSONResponse, Response

        if not _authorized(request):
            return JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401)
        # Same container as speech, no audio. Enter has already loaded Kokoro.
        if item.get("warm") is True:
            if not self.gate.acquire(blocking=False):
                return {"ok": True, "state": "busy"}
            try:
                # Enter has already loaded Drew when its volume is mounted.
                return {"ok": True, "state": "warm"}
            finally:
                self.gate.release()
        text = str(item.get("text") or "")
        if not text.strip() or len(text) > MAX_CHARS:
            return JSONResponse({"ok": False, "error": "text cap"}, status_code=400)
        sys.path.insert(0, "/opt/sowell/scripts")
        from pack import PackError, canonical_kokoro_voice

        try:
            voice = canonical_kokoro_voice(str(item.get("voice") or "am_sowell"))
        except PackError:
            return JSONResponse({"ok": False, "error": "voice is not allowed"}, status_code=400)
        from drew import DREW_VOICE_ID

        if voice == DREW_VOICE_ID and not self._ensure_drew():
            return JSONResponse(
                {"ok": False, "error": "Drew weights are not mounted", "code": "DREW_UNAVAILABLE"},
                status_code=503,
            )
        # Missing means stock. Only an explicit "G" edits F0. The container
        # env is not consulted: the cache key lives in the process that
        # sent this body, and a ruled take under the unruled key would stick.
        raw_prosody = item.get("prosody", None)
        if raw_prosody is None or raw_prosody == "":
            prosody = ""
        elif raw_prosody == "G":
            prosody = "G"
        else:
            return JSONResponse(
                {"ok": False, "error": "prosody is not supported"},
                status_code=400,
            )
        if prosody and self.runtime == "onnx":
            return JSONResponse(
                {"ok": False, "error": "prosody G needs KOKORO_RUNTIME=torch"},
                status_code=400,
            )
        recipe = item.get("master")
        if recipe is not None and not isinstance(recipe, dict):
            return JSONResponse({"ok": False, "error": "master is not an object"}, status_code=400)
        if not self.gate.acquire(blocking=False):
            return JSONResponse({"ok": False, "deferred": True}, status_code=429)
        holding = True
        try:
            if self.runtime == "onnx":
                wav, report = self.engine.speak(text, voice, item.get("speed", 1.0))
            else:
                wav, report = self.engine.speak(
                    text,
                    Path(PACK),
                    Path(MANIFEST),
                    voice=voice,
                    speed=item.get("speed", 1.0),
                    prosody=prosody,
                )
            if len(wav) < 1000:
                return JSONResponse({"ok": False, "error": "empty audio"}, status_code=500)
            from timing import timing_headers

            from pronounce import PRONUNCIATION_ID

            headers = timing_headers(report)
            headers["x-kokoro-voice"] = str(report.get("voice") or voice)
            headers["x-kokoro-speed"] = str(report.get("speed") or 1.0)
            # The cache key ends in this id. An image that omits the header
            # is the lexicon from before it, and the worker must not store
            # that audio under the new key.
            headers["x-kokoro-pronunciation"] = PRONUNCIATION_ID
            if report.get("prosody"):
                headers["x-kokoro-prosody"] = str(report["prosody"])
            # Id, section, and voice only. The text and the token are not logged.
            job_id = str(item.get("jobId") or "")[:80]
            section = item.get("sectionIndex")
            print(
                "[kokoro] "
                + str(
                    {
                        "jobId": job_id,
                        "section": section if isinstance(section, int) else None,
                        **headers,
                        "bytes": len(wav),
                    }
                ),
                flush=True,
            )
            headers["x-kokoro-runtime"] = self.runtime
            headers["x-kokoro-rss-mb"] = f"{process_high_water_mb():.0f}"
            peak = cgroup_peak_mb()
            if peak is not None:
                headers["x-kokoro-cgroup-mb"] = f"{peak:.0f}"
            if recipe is not None:
                from master import MasterError, master_wav

                # The permit is the speech lane. ffmpeg is another process;
                # holding the permit left the other streams idle for the loudnorm.
                self.gate.release()
                holding = False
                started = time.perf_counter()
                try:
                    mp3, info = master_wav(wav, float(report.get("seconds") or 0), recipe)
                except (MasterError, OSError, subprocess.SubprocessError) as err:
                    # The worker masters the WAV on the CPU app, as before.
                    headers["x-kokoro-master-error"] = str(err)[:200].replace("\n", " ")
                else:
                    headers["x-kokoro-master"] = str(info.get("plan"))
                    headers["x-kokoro-master-seconds"] = f"{time.perf_counter() - started:.3f}"
                    headers["x-kokoro-mp3-bytes"] = str(len(mp3))
                    headers["x-kokoro-wav-bytes"] = str(len(wav))
                    return Response(
                        content=mp3 + wav,
                        media_type=KOKORO_BUNDLE_CONTENT_TYPE,
                        headers=headers,
                    )
            return Response(content=wav, media_type="audio/wav", headers=headers)
        except Exception as err:
            return JSONResponse({"ok": False, "error": str(err)[:300]}, status_code=500)
        finally:
            if holding:
                self.gate.release()


@app.function(
    image=image,
    cpu=2,
    memory=8192,
    timeout=1800,
    volumes={DREW_VOLUME_MOUNT: drew_volume},
)
def export_drew_onnx() -> str:
    """Export Drew's checkpoint to ONNX next to it on his volume. Idempotent.

    Runs the exporter in a child process (it needs torch; the serving process
    does not import it), then commits the volume. Containers that start after
    this load Drew from the export; ``onnx_engine.read_manifest`` checks every
    file's SHA-256 first.
    """
    sys.path.insert(0, "/opt/sowell/scripts")
    from onnx_engine import drew_onnx_dir

    out = drew_onnx_dir()
    run = subprocess.run(
        [sys.executable, "/opt/sowell/scripts/onnx_export.py", "drew", "--out", str(out)],
        capture_output=True,
        text=True,
    )
    if run.returncode != 0:
        raise RuntimeError(f"Drew ONNX export failed: {run.stderr[-800:]}")
    drew_volume.commit()
    return run.stdout
