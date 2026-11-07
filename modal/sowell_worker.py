"""Sowell on Modal CPU. A separate app from echomancer-cpu and echomancer-s2-clone.

    modal deploy modal/sowell_worker.py

min_containers is 0. Deploying this does not reset the GPU autoscaler and
does not run on the take-home VM. The voice pack is baked at image build
from voices/sowell/am_sowell_avg.pt, which is not committed.

Secret `echomancer-sowell`: SOWELL_TOKEN. Do not commit the value.
"""

from __future__ import annotations

import os
import subprocess
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
_gate = threading.Lock()
MAX_CHARS = 280


def _authorized(request: Request) -> bool:
    expected = os.environ.get("SOWELL_TOKEN", "")
    if not expected:
        return False
    return request.headers.get("authorization", "") == f"Bearer {expected}"


@app.function(
    image=image,
    cpu=2,
    memory=4096,
    timeout=180,
    min_containers=0,
    max_containers=int(os.environ.get("SOWELL_MAX_CONTAINERS", "2")),
    scaledown_window=int(os.environ.get("SOWELL_SCALEDOWN_SECONDS", "60")),
    secrets=[modal.Secret.from_name("echomancer-sowell")],
)
@modal.fastapi_endpoint(method="POST", docs=False)
def speak(item: dict, request: Request):
    from fastapi.responses import JSONResponse, Response

    if not _authorized(request):
        return JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401)
    text = str(item.get("text") or "")
    if not text.strip() or len(text) > MAX_CHARS:
        return JSONResponse({"ok": False, "error": "text cap"}, status_code=400)
    if not _gate.acquire(blocking=False):
        return JSONResponse({"ok": False, "deferred": True}, status_code=429)
    out = "/tmp/sowell.wav"
    try:
        proc = subprocess.run(
            [
                "python",
                "/opt/sowell/scripts/synthesize.py",
                "--pack",
                os.environ.get("SOWELL_PACK", "/opt/sowell/voices/am_sowell_avg.pt"),
                "--manifest",
                os.environ.get("SOWELL_MANIFEST", "/opt/sowell/voices/manifest.json"),
                "--text",
                text,
                "--out",
                out,
            ],
            cwd="/opt/sowell/scripts",
            check=False,
            capture_output=True,
            timeout=150,
        )
        if proc.returncode != 0:
            detail = (proc.stderr or b"")[-400:].decode("utf-8", "replace")
            return JSONResponse({"ok": False, "error": detail}, status_code=500)
        audio = Path(out).read_bytes()
        if len(audio) < 1000:
            return JSONResponse({"ok": False, "error": "empty audio"}, status_code=500)
        return Response(content=audio, media_type="audio/wav")
    finally:
        _gate.release()
