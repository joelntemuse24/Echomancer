"""Keep pytest from authenticating to Modal.

Imported by ``modal/conftest.py`` and ``scripts/conftest.py`` before tests
run. Stripping the variables here, not only inside a fixture, covers
collection and any subprocess a test starts with ``os.environ``.

The Modal client resolves a hostname and then connects to the IP, so a
guard on ``socket.connect`` hostnames never sees the name. DNS lookup and
``create_connection`` are refused for ``*.modal.com`` and ``*.modal.run``.
``modal.client`` is poisoned on import, including an import that happens
after the fixture is installed.
"""

from __future__ import annotations

import asyncio
import builtins
import ipaddress
import os
import socket
import sys
import tempfile
from pathlib import Path

CRED_KEYS = ("MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "MODAL_PROFILE")
BLOCKED_MESSAGE = "tests must not call Modal"

_CONFIG_DIR = Path(tempfile.mkdtemp(prefix="echomancer-modal-test-"))
_CONFIG_FILE = _CONFIG_DIR / "modal.toml"
_CONFIG_FILE.write_text("")
_GUARD_FILE = Path(__file__).resolve()
_SITECUSTOMIZE = _CONFIG_DIR / "sitecustomize.py"
_SITECUSTOMIZE.write_text(
    "import importlib.util\n"
    "from pathlib import Path\n"
    f"_path = Path({str(_GUARD_FILE)!r})\n"
    "_spec = importlib.util.spec_from_file_location('_echomancer_no_live_modal', _path)\n"
    "if _spec is not None and _spec.loader is not None:\n"
    "    _mod = importlib.util.module_from_spec(_spec)\n"
    "    _spec.loader.exec_module(_mod)\n"
    "    _mod.install_process_guard()\n"
)


def strip_modal_credentials() -> None:
    """Drop live auth and point Modal at an empty config file."""
    for key in CRED_KEYS:
        os.environ.pop(key, None)
    os.environ["MODAL_CONFIG_PATH"] = str(_CONFIG_FILE)
    current = os.environ.get("PYTHONPATH", "")
    entries = [entry for entry in current.split(os.pathsep) if entry]
    site = str(_CONFIG_DIR)
    if site not in entries:
        os.environ["PYTHONPATH"] = os.pathsep.join([site, *entries])


strip_modal_credentials()


def is_modal_host(host: object) -> bool:
    """True for Modal API and web hostnames. An IP address is not a hostname."""
    if isinstance(host, bytes):
        try:
            host = host.decode("ascii")
        except UnicodeDecodeError:
            return False
    if not isinstance(host, str):
        return False
    name = host.lower().strip().rstrip(".")
    if not name:
        return False
    try:
        ipaddress.ip_address(name.strip("[]"))
    except ValueError:
        pass
    else:
        return False
    return (
        name == "modal.com"
        or name.endswith(".modal.com")
        or name == "modal.run"
        or name.endswith(".modal.run")
    )


def _blocked(host: object) -> RuntimeError:
    return RuntimeError(f"{BLOCKED_MESSAGE} ({host})")


def _mark(fn):
    fn._echomancer_modal_guard = True  # type: ignore[attr-defined]
    return fn


def _already(fn: object) -> bool:
    return bool(getattr(fn, "_echomancer_modal_guard", False))


def _guard_getaddrinfo(real):
    @_mark
    def guarded(host, *args, **kwargs):
        if is_modal_host(host):
            raise _blocked(host)
        return real(host, *args, **kwargs)

    return guarded


def _guard_connect(real):
    @_mark
    def guarded(self, address):
        host = ""
        if isinstance(address, tuple) and address:
            host = address[0]
        if is_modal_host(host):
            raise _blocked(host)
        return real(self, address)

    return guarded


def _guard_loop_getaddrinfo(real):
    @_mark
    async def guarded(self, host, port, *args, **kwargs):
        if is_modal_host(host):
            raise _blocked(host)
        return await real(self, host, port, *args, **kwargs)

    return guarded


def _guard_create_connection(real):
    @_mark
    async def guarded(self, protocol_factory, host=None, port=None, *args, **kwargs):
        if is_modal_host(host):
            raise _blocked(host)
        return await real(self, protocol_factory, host, port, *args, **kwargs)

    return guarded


def _poison_from_env(cls) -> None:
    current = getattr(cls, "from_env", None)
    if current is None or _already(current):
        return

    @_mark
    def blocked(*_args, **_kwargs):
        raise RuntimeError(f"{BLOCKED_MESSAGE}; credentials are stripped")

    try:
        cls.from_env = blocked
    except (AttributeError, TypeError):
        return


def poison_modal_client(module=None) -> None:
    """Make ``from_env`` raise. Safe when the module is a test stub."""
    client = module if module is not None else sys.modules.get("modal.client")
    if client is None:
        return
    for name in ("_Client", "Client"):
        cls = getattr(client, name, None)
        if isinstance(cls, type):
            _poison_from_env(cls)
    package = sys.modules.get("modal")
    public = getattr(package, "Client", None) if package is not None else None
    if isinstance(public, type):
        _poison_from_env(public)


def _wrapping_import(real):
    @_mark
    def guarded(name, globals=None, locals=None, fromlist=(), level=0):
        module = real(name, globals, locals, fromlist, level)
        if name == "modal" or name == "modal.client" or (
            isinstance(name, str) and name.startswith("modal.")
        ):
            poison_modal_client()
        return module

    return guarded


def _apply_socket_and_asyncio(assign) -> None:
    """``assign(obj, name, value)`` is setattr or monkeypatch.setattr."""
    if not _already(socket.getaddrinfo):
        assign(socket, "getaddrinfo", _guard_getaddrinfo(socket.getaddrinfo))
    if not _already(socket.socket.connect):
        assign(socket.socket, "connect", _guard_connect(socket.socket.connect))
    loop = asyncio.base_events.BaseEventLoop
    if not _already(loop.getaddrinfo):
        assign(loop, "getaddrinfo", _guard_loop_getaddrinfo(loop.getaddrinfo))
    if not _already(loop.create_connection):
        assign(loop, "create_connection", _guard_create_connection(loop.create_connection))


def install_process_guard() -> None:
    """Patch this process in place. Subprocesses use this from sitecustomize."""
    strip_modal_credentials()
    _apply_socket_and_asyncio(setattr)
    if not _already(builtins.__import__):
        builtins.__import__ = _wrapping_import(builtins.__import__)
    poison_modal_client()


def install_guard(monkeypatch) -> None:
    """Re-apply the strip for one test and fail a real Modal client call."""
    strip_modal_credentials()
    for key in CRED_KEYS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("MODAL_CONFIG_PATH", str(_CONFIG_FILE))
    monkeypatch.setenv("PYTHONPATH", os.environ["PYTHONPATH"])
    _apply_socket_and_asyncio(monkeypatch.setattr)
    if not _already(builtins.__import__):
        monkeypatch.setattr(builtins, "__import__", _wrapping_import(builtins.__import__))
    poison_modal_client()
