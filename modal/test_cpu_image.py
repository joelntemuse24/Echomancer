"""The CPU image must be an interpreter Modal can see, without replacing Whisper's.

Modal runs `python -VV` on a Dockerfile image and refuses the Function
when that command is missing (`unable to determine the version of Python`).
`add_python` would satisfy that probe by copying a second Python onto
`/usr/local`, which is ahead of apt on PATH, so `python3` would no longer
be the interpreter that has `faster-whisper`. This test imports the app
against a fake Modal client and checks the image recipe. It does not build
or deploy an image.
"""

from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class _Image:
    def __init__(self) -> None:
        self.from_dockerfile_calls: list[tuple] = []
        self.pip_calls: list[tuple] = []

    def pip_install(self, *args, **kwargs):
        self.pip_calls.append((args, kwargs))
        return self


def test_cpu_worker_image_keeps_apt_python_and_installs_fastapi_for_modal():
    dockerfile = (ROOT / "workers" / "cpu" / "Dockerfile").read_text()
    assert "FROM node:22-bookworm-slim" in dockerfile
    assert "ffmpeg" in dockerfile
    assert "python3" in dockerfile
    assert "python-is-python3" in dockerfile
    assert "faster-whisper==1.1.1" in dockerfile
    assert "python -VV" in dockerfile
    assert "TTS_QA_WHISPER_PYTHON=/usr/bin/python3" in dockerfile
    assert "fastapi==" not in dockerfile

    built = _Image()

    def from_dockerfile(*args, **kwargs):
        built.from_dockerfile_calls.append((args, kwargs))
        return built

    modal = types.ModuleType("modal")

    class Image:
        pass

    Image.from_dockerfile = staticmethod(from_dockerfile)

    class App:
        def __init__(self, name):
            self.name = name

        def function(self, **kwargs):
            def decorate(fn):
                fn.image = kwargs.get("image")
                return fn

            return decorate

    modal.Image = Image
    modal.App = App
    modal.Secret = types.SimpleNamespace(from_name=lambda name: name)
    modal.fastapi_endpoint = lambda *a, **k: (lambda fn: fn)
    sys.modules["modal"] = modal

    fastapi = types.ModuleType("fastapi")

    class Request:
        headers: dict = {}

    fastapi.Request = Request
    sys.modules["fastapi"] = fastapi
    responses = types.ModuleType("fastapi.responses")
    responses.JSONResponse = lambda *a, **k: None
    sys.modules["fastapi.responses"] = responses

    sys.path.insert(0, str(ROOT / "modal"))
    sys.modules.pop("cpu_worker", None)
    try:
        worker = importlib.import_module("cpu_worker")
    finally:
        sys.path.remove(str(ROOT / "modal"))
    assert worker.APP_NAME == "echomancer-cpu"
    assert worker.image is built
    assert built.from_dockerfile_calls, "from_dockerfile was not called"
    args, kwargs = built.from_dockerfile_calls[0]
    assert args[0].name == "Dockerfile"
    assert kwargs["context_dir"] == ROOT
    assert "add_python" not in kwargs
    assert built.pip_calls == [(("fastapi[standard]==0.115.6",), {})]
    assert "node" in dockerfile
    assert "ffmpeg" in dockerfile
