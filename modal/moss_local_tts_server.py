"""
MOSS-TTS Local-Transformer deploy entry point.

Sets MOSS_DEPLOY_VARIANT=local before loading the shared server module so Modal
builds the L40S image with MOSS-TTS-Local-Transformer-v1.5.

Deploy:
  modal deploy modal/moss_local_tts_server.py
"""

from __future__ import annotations

import os

os.environ["MOSS_DEPLOY_VARIANT"] = "local"

from moss_tts_server import app  # noqa: E402, F401