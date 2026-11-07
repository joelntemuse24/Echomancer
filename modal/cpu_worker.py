"""CPU workers on Modal: extract, section master, local Whisper, final concat.

This is a separate app from `echomancer-s2-clone`. Deploying it does not
reset the GPU autoscaler. There is no GPU on this app.

    modal deploy modal/cpu_worker.py

The container runs `src/worker/cpu-once.ts`, which claims the `cpu_tasks`
row and reads and writes object storage. It does not share a temp
directory with the take-home VM.

Scale to zero: `min_containers` is 0. `CPU_MAX_CONTAINERS` (default 4)
is the fleet cap. `CPU_FUNCTION_CPU` and `CPU_FUNCTION_MEMORY_MB` are the
per-container billing dimensions. `CPU_SCALEDOWN_SECONDS` (default 60) is
how long an idle container stays up. Idle cost is zero once the container
is gone. This file does not record a measured dollar figure.

The image does not download Whisper weights. The first QA task on a
deployed container fetches the `base` model into that container. That
fetch is a deploy-smoke step, not part of building this file.

Secret `echomancer-cpu` (create it in Modal; do not commit the values):
    TURSO_DATABASE_URL, TURSO_AUTH_TOKEN
    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
    MODAL_CPU_TOKEN
    WORKER=1
    CPU_RUNNER=local
"""

from __future__ import annotations

import os
import signal
import subprocess
import threading
from pathlib import Path

import modal
from fastapi import Request

APP_NAME = os.environ.get("CPU_APP_NAME", "echomancer-cpu")
CPU = float(os.environ.get("CPU_FUNCTION_CPU", "2"))
MEMORY_MB = int(os.environ.get("CPU_FUNCTION_MEMORY_MB", "4096"))
TIMEOUT_S = int(os.environ.get("CPU_FUNCTION_TIMEOUT_S", "900"))
MAX_CONTAINERS = int(os.environ.get("CPU_MAX_CONTAINERS", "4"))
SCALEDOWN_S = int(os.environ.get("CPU_SCALEDOWN_SECONDS", "60"))

# Context is the repository root, not workers/cpu/. The Dockerfile copies
# package.json and the app from that root. Modal otherwise uses the
# Dockerfile's own directory, and the image would not contain the worker.
_ROOT = Path(__file__).resolve().parents[1]
image = modal.Image.from_dockerfile(
    _ROOT / "workers" / "cpu" / "Dockerfile",
    context_dir=_ROOT,
)

app = modal.App(APP_NAME)

# One task at a time inside a container. A second request gets 429 and
# the orchestrator leaves the row queued. Another container, up to
# CPU_MAX_CONTAINERS, can take it. The endpoint is served on a worker
# thread, so the gate is a lock rather than a bare flag.
_gate = threading.Lock()


def _authorized(request: Request) -> bool:
    expected = os.environ.get("MODAL_CPU_TOKEN", "")
    if not expected:
        return False
    header = request.headers.get("authorization", "")
    return header == f"Bearer {expected}"


@app.function(
    image=image,
    cpu=CPU,
    memory=MEMORY_MB,
    timeout=TIMEOUT_S,
    min_containers=0,
    max_containers=MAX_CONTAINERS,
    scaledown_window=SCALEDOWN_S,
    secrets=[modal.Secret.from_name("echomancer-cpu")],
)
@modal.fastapi_endpoint(method="POST", docs=False)
def run(item: dict, request: Request):
    """Claim and run one cpu_tasks row. 429 when this container is busy."""
    from fastapi.responses import JSONResponse

    if not _authorized(request):
        return JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401)
    task_id = str(item.get("taskId") or "")
    if not task_id or "/" in task_id or ".." in task_id or len(task_id) > 200:
        return JSONResponse({"ok": False, "error": "bad task"}, status_code=400)
    if not _gate.acquire(blocking=False):
        return JSONResponse({"ok": False, "deferred": True}, status_code=429)
    env = os.environ.copy()
    env["CPU_RUNNER"] = "local"
    env["CPU_HOST_ID"] = os.environ.get("MODAL_TASK_ID") or "modal-cpu"
    env["WORKER"] = "1"
    try:
        proc = subprocess.Popen(
            [
                "node",
                "--import",
                "tsx",
                "/opt/echomancer/src/worker/cpu-once.ts",
                task_id,
            ],
            cwd="/opt/echomancer",
            env=env,
            start_new_session=True,
        )
        try:
            code = proc.wait(timeout=max(30, TIMEOUT_S - 30))
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=10)
            return JSONResponse({"ok": False, "deferred": True}, status_code=429)
        if code == 75:
            return JSONResponse({"ok": False, "deferred": True}, status_code=429)
        if code != 0:
            return JSONResponse({"ok": False, "code": code}, status_code=500)
        return {"ok": True, "taskId": task_id}
    finally:
        _gate.release()
