"""Voice id allowlist. No model load."""

import unittest

from pack import PackError, canonical_kokoro_voice


class VoiceAllowlist(unittest.TestCase):
    def test_names_and_aliases(self) -> None:
        self.assertEqual(canonical_kokoro_voice(None), "am_sowell")
        self.assertEqual(canonical_kokoro_voice("sowell"), "am_sowell")
        self.assertEqual(canonical_kokoro_voice("am_sowell_avg"), "am_sowell")
        self.assertEqual(canonical_kokoro_voice("george"), "bm_george")
        self.assertEqual(canonical_kokoro_voice("bm_george"), "bm_george")

    def test_rejects_paths_and_other_voices(self) -> None:
        for raw in ("../bm_george", "voices/bm_george.pt", "bm_george.pt", "af_bella", "bm_lewis"):
            with self.assertRaises(PackError):
                canonical_kokoro_voice(raw)


if __name__ == "__main__":
    unittest.main()
