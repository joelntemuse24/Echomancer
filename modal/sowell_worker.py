"""Sowell on Modal CPU. A separate app from echomancer-cpu and echomancer-s2-clone.

    modal deploy modal/sowell_worker.py

Each container loads Kokoro once in ``@modal.enter`` and reuses that
runtime until idle scale-down. ``min_containers`` is 0. One request at a
time per container, because the model is not reentrant. A second request
gets 429 so the caller can use the other container. The cap stays 2
containers, 2 CPU, 4 GB.

Secret ``echomancer-sowell``: ``SOWELL_TOKEN``. The voice pack is baked
at image build and is not committed.
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

app = modal.App(APP_NAME)
MAX_CHARS = 2000
PACK = os.environ.get("SOWELL_PACK", "/opt/sowell/voices/am_sowell_avg.pt")
MANIFEST = os.environ.get("SOWELL_MANIFEST", "/opt/sowell/voices/manifest.json")


def _authorized(request: Request) -> bool:
    expected = os.environ.get("SOWELL_TOKEN", "")
    if not expected:
        return False
    return request.headers.get("authorization", "") == f"Bearer {expected}"


@app.cls(
    image=image,
    cpu=2,
    memory=4096,
    timeout=180,
    min_containers=0,
    max_containers=int(os.environ.get("SOWELL_MAX_CONTAINERS", "2")),
    scaledown_window=int(os.environ.get("SOWELL_SCALEDOWN_SECONDS", "60")),
    secrets=[modal.Secret.from_name("echomancer-sowell")],
)
@modal.concurrent(max_inputs=1)
class Speaker:
    @modal.enter()
    def load(self) -> None:
        sys.path.insert(0, "/opt/sowell/scripts")
        from engine import SowellEngine

        self.engine = SowellEngine()
        self.engine.load(Path(PACK), Path(MANIFEST))
        self.gate = threading.Lock()

    @modal.fastapi_endpoint(method="POST", docs=False)
    def speak(self, item: dict, request: Request):
        from fastapi.responses import JSONResponse, Response

        if not _authorized(request):
            return JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401)
        text = str(item.get("text") or "")
        if not text.strip() or len(text) > MAX_CHARS:
            return JSONResponse({"ok": False, "error": "text cap"}, status_code=400)
        if not self.gate.acquire(blocking=False):
            return JSONResponse({"ok": False, "deferred": True}, status_code=429)
        try:
            wav, _report = self.engine.speak(text, Path(PACK), Path(MANIFEST))
            if len(wav) < 1000:
                return JSONResponse({"ok": False, "error": "empty audio"}, status_code=500)
            return Response(content=wav, media_type="audio/wav")
        except Exception as err:
            return JSONResponse({"ok": False, "error": str(err)[:300]}, status_code=500)
        finally:
            self.gate.release()
