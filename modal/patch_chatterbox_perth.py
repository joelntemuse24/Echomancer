"""Patch Chatterbox to use DummyWatermarker when Perth binary is unavailable."""
import pathlib

import chatterbox

for name in ("tts_turbo.py", "mtl_tts.py"):
    path = pathlib.Path(chatterbox.__file__).parent / name
    if not path.exists():
        continue
    text = path.read_text()
    old = "perth.PerthImplicitWatermarker()"
    new = (
        "perth.DummyWatermarker() if getattr(perth, 'PerthImplicitWatermarker', None) "
        "is None else perth.PerthImplicitWatermarker()"
    )
    if old in text:
        path.write_text(text.replace(old, new))
        print(f"Patched {path}")