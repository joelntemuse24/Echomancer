"""Same Modal lock as ``modal/conftest.py``, for ``pytest scripts``.

The drain and autoscaler tests live under ``modal/``. This file covers a
run that collects ``scripts/`` directly.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "modal"))

from no_live_modal import install_guard  # noqa: E402


@pytest.fixture(autouse=True)
def _no_live_modal(monkeypatch):
    install_guard(monkeypatch)
