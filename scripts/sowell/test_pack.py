"""Malformed packs are refused. No model download."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pack import PINNED_REPO, PINNED_REVISION, PackError, check_pack


def manifest_for(digest: str, **over) -> dict:
    base = {
        "sha256": digest,
        "bytes": None,
        "shape": [510, 1, 256],
        "base": {
            "repo": PINNED_REPO,
            "revision": PINNED_REVISION,
            "weights": "kokoro-v1_0.pth",
        },
    }
    base.update(over)
    return base


class PackChecks(unittest.TestCase):
    def test_accepts_a_finite_matching_tensor(self) -> None:
        tensor = torch.zeros(510, 1, 256)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "voice.pt"
            torch.save(tensor, path)
            digest = __import__("hashlib").sha256(path.read_bytes()).hexdigest()
            loaded = check_pack(path, manifest_for(digest, bytes=path.stat().st_size))
            self.assertEqual(tuple(loaded.shape), (510, 1, 256))

    def test_rejects_a_wrong_shape_and_a_non_finite_value(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "voice.pt"
            torch.save(torch.zeros(3, 3), path)
            digest = __import__("hashlib").sha256(path.read_bytes()).hexdigest()
            with self.assertRaises(PackError):
                check_pack(path, manifest_for(digest, bytes=path.stat().st_size))
            bad = torch.zeros(510, 1, 256)
            bad[0, 0, 0] = float("nan")
            torch.save(bad, path)
            digest = __import__("hashlib").sha256(path.read_bytes()).hexdigest()
            with self.assertRaises(PackError):
                check_pack(path, manifest_for(digest, bytes=path.stat().st_size))

    def test_rejects_a_different_base(self) -> None:
        tensor = torch.zeros(510, 1, 256)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "voice.pt"
            torch.save(tensor, path)
            digest = __import__("hashlib").sha256(path.read_bytes()).hexdigest()
            body = manifest_for(digest, bytes=path.stat().st_size)
            body["base"] = {
                "repo": "hexgrad/Kokoro-82M-v1.1-zh",
                "revision": PINNED_REVISION,
                "weights": "kokoro-v1_1-zh.pth",
            }
            with self.assertRaises(PackError):
                check_pack(path, body)

    def test_shipped_manifest_matches_the_documented_hash(self) -> None:
        root = Path(__file__).resolve().parents[2]
        manifest = json.loads((root / "voices" / "sowell" / "manifest.json").read_text())
        self.assertEqual(
            manifest["sha256"],
            "a9fa4422864e0048d035ead9ad6a304170f73aec409271903b05c9a789c7510d",
        )
        self.assertIsNone(manifest["trainerCheckpointSha256"])
        self.assertEqual(manifest["base"]["repo"], PINNED_REPO)


if __name__ == "__main__":
    unittest.main()
