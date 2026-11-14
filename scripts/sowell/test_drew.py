"""Drew's speed mapping and asset paths. No torch, no model load.

`drew_speed` is the one place 0.88 is applied, and it must be applied exactly
once: the worker sends the app's own speed, and this multiplies it. A double
multiply would put 1.0 at 0.774 and make Drew sound nothing like Andrew.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from drew import (  # noqa: E402
    DREW_KMODEL_PATH,
    DREW_NATIVE_KOKORO_SPEED,
    DREW_VOICE_PACK_PATH,
    DREW_VOLUME_MOUNT,
    DREW_VOICE_ID,
    drew_kmodel_path,
    drew_speed,
    drew_voice_pack_path,
)


class DrewSpeed(unittest.TestCase):
    def test_native_one_is_eighty_eight(self) -> None:
        self.assertEqual(DREW_NATIVE_KOKORO_SPEED, 0.88)
        self.assertEqual(drew_speed(1.0), 0.88)
        self.assertEqual(drew_speed(None), 0.88)
        self.assertEqual(drew_speed(""), 0.88)
        self.assertEqual(drew_speed("junk"), 0.88)
        self.assertEqual(drew_speed(0), 0.88)
        self.assertEqual(drew_speed(-2), 0.88)

    def test_scales_from_native_without_a_second_slowdown(self) -> None:
        self.assertEqual(drew_speed(0.95), 0.836)
        self.assertEqual(drew_speed(1.2), 1.056)
        # The old calibration floor sat near 0.85; Drew's natural pace is
        # already there, so 1.0 must not land under it.
        self.assertGreater(drew_speed(1.0), 0.85)

    def test_clamps_to_what_the_container_accepts(self) -> None:
        self.assertEqual(drew_speed(0.001), 0.5)
        self.assertEqual(drew_speed(100), 2.0)


class DrewPaths(unittest.TestCase):
    def test_defaults_are_the_documented_volume_paths(self) -> None:
        self.assertEqual(DREW_VOICE_ID, "drew")
        self.assertEqual(DREW_VOLUME_MOUNT, "/andrew-distill")
        self.assertEqual(
            DREW_KMODEL_PATH, "/kokoro/retrain_v3/stageA/step00900_kmodel.pth"
        )
        self.assertEqual(
            DREW_VOICE_PACK_PATH, "/kokoro/retrain_v3/stageA/step00900_voice.pt"
        )

    def test_env_can_move_the_volume_or_the_paths(self) -> None:
        env = {
            "DREW_VOLUME_MOUNT": "/mnt/weights/",
            "DREW_KMODEL_RELATIVE_PATH": "/custom/model.pth",
            "DREW_VOICE_RELATIVE_PATH": "voice.pt",
        }
        self.assertEqual(drew_kmodel_path(env), Path("/mnt/weights/custom/model.pth"))
        self.assertEqual(drew_voice_pack_path(env), Path("/mnt/weights/voice.pt"))

    def test_defaults_do_not_double_the_leading_slash(self) -> None:
        self.assertEqual(
            drew_kmodel_path({}), Path("/andrew-distill" + DREW_KMODEL_PATH)
        )
        self.assertNotIn("//", str(drew_kmodel_path({})))


if __name__ == "__main__":
    unittest.main()
