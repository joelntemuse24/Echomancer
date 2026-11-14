"""Drew: a fine-tuned Kokoro-82M with its own kmodel weights and voice pack.

Unlike Walter (a voice pack on stock Kokoro) this is a **different model**.
So the container keeps two resident kmodels next to each other:

* stock `kokoro-v1_0.pth` for Walter (`am_sowell`) and George (`bm_george`)
* the Drew checkpoint for Drew

Both are ~330 MB fp32, which is why the container asks for 6 GB instead of 4.

The files are private and are **not** in this repository. They come from a
Modal Volume, default `andrew-distill`, mounted at `/andrew-distill`:

    /kokoro/retrain_v3/stageA/step00900_kmodel.pth   313 MB
    /kokoro/retrain_v3/stageA/step00900_voice.pt     voice pack

The voice pack uses the Kokoro-82M v1.0 contract: shape `(510, 1, 256)`,
float32, indexed with `pack[phoneme_count - 1]`. Nothing is pinned by hash
because the checkpoint is private and can be re-exported; the layout, dtype,
and finiteness are checked instead, and a bad file fails the container load
rather than producing audio that is not Drew.

**0.88 is Drew's native 1x.** Rendering at Kokoro speed 0.88 reproduces real
Andrew's natural pace. The app sends its own speed (1.0 = natural) and this
module multiplies it, once.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

DREW_VOICE_ID = "drew"
DREW_NATIVE_KOKORO_SPEED = 0.88
DREW_SPEED_MIN = 0.5
DREW_SPEED_MAX = 2.0
PACK_SHAPE = (510, 1, 256)

DEFAULT_VOLUME_MOUNT = "/andrew-distill"
DREW_VOLUME_MOUNT = DEFAULT_VOLUME_MOUNT
DREW_KMODEL_PATH = "/kokoro/retrain_v3/stageA/step00900_kmodel.pth"
DREW_VOICE_PACK_PATH = "/kokoro/retrain_v3/stageA/step00900_voice.pt"


class DrewPackError(Exception):
    pass


def drew_kmodel_path(env: dict[str, str] | None = None) -> Path:
    env = os.environ if env is None else env
    mount = env.get("DREW_VOLUME_MOUNT", DEFAULT_VOLUME_MOUNT).rstrip("/")
    relative = env.get("DREW_KMODEL_RELATIVE_PATH", DREW_KMODEL_PATH)
    return Path(mount + "/" + relative.lstrip("/"))


def drew_voice_pack_path(env: dict[str, str] | None = None) -> Path:
    env = os.environ if env is None else env
    mount = env.get("DREW_VOLUME_MOUNT", DEFAULT_VOLUME_MOUNT).rstrip("/")
    relative = env.get("DREW_VOICE_RELATIVE_PATH", DREW_VOICE_PACK_PATH)
    return Path(mount + "/" + relative.lstrip("/"))


def drew_assets_present(env: dict[str, str] | None = None) -> bool:
    """Both files exist. A partial volume is not Drew's app to guess about."""
    return drew_kmodel_path(env).is_file() and drew_voice_pack_path(env).is_file()


def drew_speed(requested: object) -> float:
    """App speed → Kokoro speed. 1.0 (or missing) becomes 0.88, exactly once."""
    try:
        base = float(requested)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        base = 1.0
    if base <= 0 or base != base:  # zero, negative, NaN
        base = 1.0
    scaled = base * DREW_NATIVE_KOKORO_SPEED
    return round(min(DREW_SPEED_MAX, max(DREW_SPEED_MIN, scaled)), 4)


@dataclass(frozen=True)
class DrewAssets:
    kmodel: Path
    voice: Path


def check_drew_assets(env: dict[str, str] | None = None) -> DrewAssets:
    kmodel = drew_kmodel_path(env)
    voice = drew_voice_pack_path(env)
    missing = [str(path) for path in (kmodel, voice) if not path.is_file()]
    if missing:
        raise DrewPackError("Drew weights missing: " + ", ".join(missing))
    return DrewAssets(kmodel=kmodel, voice=voice)


def load_voice_pack(path: Path):
    """The `(510, 1, 256)` float32 tensor. Refuses anything else."""
    import torch

    try:
        pack = torch.load(path, map_location="cpu", weights_only=True)
    except TypeError as err:  # torch too old for weights_only
        raise DrewPackError("this torch cannot load with weights_only=True") from err
    except Exception as err:
        raise DrewPackError(f"Drew voice pack refused: {err}") from err
    if not isinstance(pack, torch.Tensor):
        raise DrewPackError(f"Drew voice pack is {type(pack).__name__}, not a tensor")
    if tuple(pack.shape) != PACK_SHAPE:
        raise DrewPackError(
            f"Drew voice pack is {tuple(pack.shape)}, want {PACK_SHAPE}"
        )
    if pack.dtype != torch.float32:
        raise DrewPackError(f"Drew voice pack dtype is {pack.dtype}, want float32")
    if not bool(torch.isfinite(pack).all()):
        raise DrewPackError("Drew voice pack has a non-finite value")
    return pack


def load_kmodel(path: Path):
    """`KModel(model=path)`, in eval mode, on CPU. Raises DrewPackError."""
    if not path.is_file():
        raise DrewPackError(f"Drew kmodel missing: {path}")
    from kokoro import KModel

    try:
        model = KModel(model=str(path))
    except Exception as err:
        raise DrewPackError(f"Drew kmodel refused: {err}") from err
    return model.eval()
