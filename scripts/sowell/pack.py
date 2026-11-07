"""Load the Sowell pack. torch.load uses weights_only=True.

The file is a Kokoro voice tensor, not a pickle of arbitrary objects.
A wrong shape, a non-finite value, a hash mismatch, or any base other
than the pinned Kokoro-82M revision is refused.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import torch

PACK_SHAPE = (510, 1, 256)
PINNED_REPO = "hexgrad/Kokoro-82M"
PINNED_REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"
PINNED_WEIGHTS = "kokoro-v1_0.pth"
# Official Kokoro-82M British male voice at that revision. Not the Sowell pack.
GEORGE_VOICE_ID = "bm_george"
GEORGE_VOICE_FILE = "voices/bm_george.pt"
GEORGE_VOICE_SHA256 = "f1bc812213dc59774769e5c80004b13eeb79bd78130b11b2d7f934542dab811b"
SOWELL_VOICE_ID = "am_sowell"
_VOICE_ALIASES = {
    "sowell": SOWELL_VOICE_ID,
    "am_sowell_avg": SOWELL_VOICE_ID,
    "george": GEORGE_VOICE_ID,
}


class PackError(Exception):
    pass


def canonical_kokoro_voice(raw: str | None) -> str:
    """Allowlist. A path, a dot, or any other id is refused."""
    name = (raw or SOWELL_VOICE_ID).strip()
    name = _VOICE_ALIASES.get(name, name)
    if name not in (SOWELL_VOICE_ID, GEORGE_VOICE_ID):
        raise PackError("voice is not allowed")
    if any(ch in name for ch in "/\\."):
        raise PackError("voice is not allowed")
    return name


def check_george_voice(path: Path) -> torch.Tensor:
    """The pinned bm_george tensor. weights_only, hash, and shape."""
    if not path.is_file():
        raise PackError(f"George voice missing: {path}")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != GEORGE_VOICE_SHA256:
        raise PackError("George voice hash does not match the pinned Kokoro file")
    pack = torch.load(path, weights_only=True, map_location="cpu")
    if not isinstance(pack, torch.Tensor):
        raise PackError("George voice is not a tensor")
    if tuple(pack.shape) != PACK_SHAPE or pack.dtype != torch.float32:
        raise PackError(f"George voice layout {tuple(pack.shape)} {pack.dtype}")
    if not bool(torch.isfinite(pack).all()):
        raise PackError("George voice has a non-finite value")
    return pack


def manifest_path(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit)
    here = Path(__file__).resolve()
    return here.parents[2] / "voices" / "sowell" / "manifest.json"


def load_manifest(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        raise PackError(f"manifest unreadable: {err}") from err
    if not isinstance(data, dict):
        raise PackError("manifest is not an object")
    return data


def check_pack(pack_path: Path, manifest: dict) -> torch.Tensor:
    base = manifest.get("base")
    if not isinstance(base, dict):
        raise PackError("manifest has no base")
    if base.get("repo") != PINNED_REPO or base.get("revision") != PINNED_REVISION:
        raise PackError(
            "refusing base "
            f"{base.get('repo')}@{base.get('revision')}; "
            f"only {PINNED_REPO}@{PINNED_REVISION} matches this pack layout"
        )
    if base.get("weights") != PINNED_WEIGHTS:
        raise PackError(f"refusing weights file {base.get('weights')}")
    if tuple(manifest.get("shape") or ()) != PACK_SHAPE:
        raise PackError(f"manifest shape {manifest.get('shape')} is not {PACK_SHAPE}")
    raw = pack_path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    expect = str(manifest.get("sha256") or "")
    if digest != expect:
        raise PackError(f"pack hash {digest} != manifest {expect}")
    if manifest.get("bytes") not in (None, len(raw)):
        raise PackError(f"pack bytes {len(raw)} != manifest {manifest.get('bytes')}")
    try:
        loaded = torch.load(pack_path, map_location="cpu", weights_only=True)
    except TypeError as err:
        raise PackError("this torch cannot load with weights_only=True") from err
    except Exception as err:
        raise PackError(f"pack refused: {err}") from err
    if not isinstance(loaded, torch.Tensor):
        raise PackError(f"pack is {type(loaded).__name__}, not a tensor")
    if tuple(loaded.shape) != PACK_SHAPE or loaded.dtype != torch.float32:
        raise PackError(f"pack is {tuple(loaded.shape)} {loaded.dtype}, want {PACK_SHAPE} float32")
    if not bool(torch.isfinite(loaded).all()):
        raise PackError("pack has a non-finite value")
    return loaded
