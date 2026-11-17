"""The Modal tripwire fails before a socket exists. No network."""

from __future__ import annotations

import asyncio
import importlib.util
import os
import socket
import subprocess
import sys
from pathlib import Path

import pytest

_CRED_KEYS = ("MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "MODAL_PROFILE")


def _child_env() -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if key not in _CRED_KEYS}
    for key in _CRED_KEYS:
        assert key not in env
    return env


def _guard():
    path = Path(__file__).resolve().parent / "no_live_modal.py"
    spec = importlib.util.spec_from_file_location("no_live_modal_for_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_dns_resolver_refuses_modal_hostnames():
    with pytest.raises(RuntimeError, match="must not call Modal"):
        socket.getaddrinfo("api.modal.com", 443)
    with pytest.raises(RuntimeError, match="must not call Modal"):
        socket.getaddrinfo("workspace--app.modal.run", 443)


def test_asyncio_resolver_and_create_connection_refuse_modal_hostnames():
    async def lookup():
        loop = asyncio.get_running_loop()
        await loop.getaddrinfo("api.modal.com", 443)

    async def connect():
        loop = asyncio.get_running_loop()
        await loop.create_connection(lambda: asyncio.Protocol(), "api.modal.com", 443)

    with pytest.raises(RuntimeError, match="must not call Modal"):
        asyncio.run(lookup())
    with pytest.raises(RuntimeError, match="must not call Modal"):
        asyncio.run(connect())


def test_an_ip_is_not_treated_as_a_modal_hostname():
    guard = _guard()
    assert guard.is_modal_host("api.modal.com") is True
    assert guard.is_modal_host("1.2.3.4") is False
    assert guard.is_modal_host("example.com") is False


def test_a_client_imported_after_the_guard_cannot_call_from_env():
    guard = _guard()

    class Client:
        @classmethod
        async def from_env(cls):
            return "network"

    class Package:
        pass

    Package.Client = Client
    Package._Client = Client

    guard.poison_modal_client(Package)
    with pytest.raises(RuntimeError, match="must not call Modal"):
        Client.from_env()


def test_subprocess_modal_client_fails_without_network(tmp_path):
    """sitecustomize poisons from_env even though the import happens later.

    CI does not install the Modal SDK. The repo's ``modal/`` directory is this
    project's sources, so a bare ``import modal.client`` is not the client.
    The stand-in below would return successfully. The guard has to stop it.
    """
    package = tmp_path / "modal"
    package.mkdir()
    (package / "__init__.py").write_text("")
    (package / "client.py").write_text(
        "class Client:\n"
        "    @classmethod\n"
        "    def from_env(cls):\n"
        "        return 'network'\n"
        "_Client = Client\n"
    )
    env = _child_env()
    entries = [entry for entry in env.get("PYTHONPATH", "").split(os.pathsep) if entry]
    assert entries and (Path(entries[0]) / "sitecustomize.py").is_file()
    env["PYTHONPATH"] = os.pathsep.join([str(tmp_path), *entries])
    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            "import modal.client; modal.client.Client.from_env()",
        ],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )
    assert completed.returncode != 0
    assert "must not call Modal" in completed.stderr + completed.stdout
