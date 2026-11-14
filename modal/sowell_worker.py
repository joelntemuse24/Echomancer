"""Drew, Walter, and George on Modal CPU.

A separate app from echomancer-cpu and echomancer-s2-clone. It is the same
`echomancer-sowell` app the Walter/George voices already ship from: Renaming
Walter is a copy change, and Drew is a second resident model on that app, not
a third fleet.

    modal deploy modal/sowell_worker.py

Each container loads stock Kokoro once in ``@modal.enter`` and reuses that
runtime until idle scale-down. ``min_containers`` is 0. One request at a
time per container, because the model is not reentrant. A second request
gets 429 so the caller can use another container in the fleet.

Fleet. ``SOWELL_MAX_CONTAINERS`` (default 6, clamped to 1..16) is the cap.
The worker's ``SOWELL_BOOK_LANES`` (also default 6, clamped to 16 and to the
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

Idle. ``SOWELL_SCALEDOWN_SECONDS`` is 60. Five minutes of idle container time
was about 40% of a measured book's cost, and the next section of a book
arrives in seconds, not minutes.

Memory. Walter and George share one stock kmodel (~330 MB). Drew is a
different kmodel of its own (~313 MB), so the ceiling moved 4 GB → 6 GB.
That is per container and does not grow with the lane count: six lanes are
six containers of the same size.

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
import sys
import threading
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
MAX_CONTAINERS_DEFAULT = 6


def max_containers(env: dict | None = None) -> int:
    """Deploy-time `max_containers`, clamped to 1..16. Default 6."""
    raw = (env or os.environ).get("SOWELL_MAX_CONTAINERS", "")
    try:
        n = int(str(raw).strip())
    except (TypeError, ValueError):
        n = MAX_CONTAINERS_DEFAULT
    return max(1, min(MAX_CONTAINERS_CEILING, n))

drew_volume = modal.Volume.from_name(DREW_VOLUME_NAME, create_if_missing=True)


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
    memory=6144,
    timeout=180,
    min_containers=0,
    max_containers=max_containers(),
    scaledown_window=int(os.environ.get("SOWELL_SCALEDOWN_SECONDS", "60")),
    secrets=[modal.Secret.from_name("echomancer-sowell")],
    volumes={DREW_VOLUME_MOUNT: drew_volume},
)
@modal.concurrent(max_inputs=1)
class Speaker:
    @modal.enter()
    def load(self) -> None:
        sys.path.insert(0, "/opt/sowell/scripts")
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
            print("[drew] weights unavailable; Drew answers 503", flush=True)
        self.gate = threading.Lock()

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
        from drew import DREW_VOICE_ID, drew_assets_present

        if voice == DREW_VOICE_ID and not drew_assets_present():
            return JSONResponse(
                {"ok": False, "error": "Drew weights are not mounted", "code": "DREW_UNAVAILABLE"},
                status_code=503,
            )
        if not self.gate.acquire(blocking=False):
            return JSONResponse({"ok": False, "deferred": True}, status_code=429)
        try:
            wav, report = self.engine.speak(
                text,
                Path(PACK),
                Path(MANIFEST),
                voice=voice,
                speed=item.get("speed", 1.0),
            )
            if len(wav) < 1000:
                return JSONResponse({"ok": False, "error": "empty audio"}, status_code=500)
            from timing import timing_headers

            headers = timing_headers(report)
            headers["x-kokoro-voice"] = str(report.get("voice") or voice)
            headers["x-kokoro-speed"] = str(report.get("speed") or 1.0)
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
            return Response(content=wav, media_type="audio/wav", headers=headers)
        except Exception as err:
            return JSONResponse({"ok": False, "error": str(err)[:300]}, status_code=500)
        finally:
            self.gate.release()
