"""Keep pytest from authenticating to Modal.

Imported by ``modal/conftest.py`` and ``scripts/conftest.py`` before tests
run. Stripping the variables here, not only inside a fixture, covers
collection and any subprocess a test starts with ``os.environ``.
"""

from __future__ import annotations

import os
import socket
import sys
import tempfile
from pathlib import Path

CRED_KEYS = ("MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "MODAL_PROFILE")

_CONFIG_DIR = Path(tempfile.mkdtemp(prefix="echomancer-modal-test-"))
_CONFIG_FILE = _CONFIG_DIR / "modal.toml"
_CONFIG_FILE.write_text("")


def strip_modal_credentials() -> None:
    """Drop live auth and point Modal at an empty config file."""
    for key in CRED_KEYS:
        os.environ.pop(key, None)
    os.environ["MODAL_CONFIG_PATH"] = str(_CONFIG_FILE)


strip_modal_credentials()


def install_guard(monkeypatch) -> None:
    """Re-apply the strip for one test and fail a real Modal socket call."""
    strip_modal_credentials()
    for key in CRED_KEYS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("MODAL_CONFIG_PATH", str(_CONFIG_FILE))

    client = sys.modules.get("modal.client")
    cls = getattr(client, "_Client", None) if client is not None else None
    if cls is not None:
        def _blocked(*_args, **_kwargs):
            raise RuntimeError(
                "tests must not call Modal; credentials are stripped"
            )

        monkeypatch.setattr(cls, "from_env", classmethod(_blocked))

    real_connect = socket.socket.connect

    def _guard(self, address):
        host = ""
        if isinstance(address, tuple) and address:
            host = address[0] if isinstance(address[0], str) else ""
        if host.endswith("modal.com") or host.endswith("modal.run"):
            raise RuntimeError(f"tests must not call Modal ({host})")
        return real_connect(self, address)

    monkeypatch.setattr(socket.socket, "connect", _guard)
