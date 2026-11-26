"""Same sentence, pinned style: brightness and level do not follow chunk length.

Skipped unless DREW_STYLE_PACK and DREW_STYLE_KMODEL point at the private
stageA step00900 files. CI does not have them. The speed argument is 1.0,
the same number an unpinned render of this sentence receives.
"""

from __future__ import annotations

import os
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

PARAGRAPH = (
    "In the spring of nineteen thirty-nine, the news from Berlin reached the "
    "physicists in Copenhagen within days. Some of them believed the discovery "
    "would change everything; others thought it was a curiosity of the "
    "laboratory, nothing more. By the end of the year, nobody was laughing."
)


def _brightness(audio) -> float:
    import torch

    # 2–5 kHz minus 0.3–2 kHz. A gain change cancels.
    window = torch.hann_window(2048)
    spec = torch.stft(audio, n_fft=2048, hop_length=512, window=window, return_complex=True)
    power = spec.abs().square().mean(dim=-1)
    freqs = torch.linspace(0, 12_000, power.shape[0])
    def band(lo: float, hi: float) -> float:
        mask = (freqs >= lo) & (freqs < hi)
        return float(10 * torch.log10(power[mask].mean().clamp_min(1e-12)))
    return band(2000, 5000) - band(300, 2000)


def _lufs_proxy(audio) -> float:
    import torch

    rms = audio.square().mean().clamp_min(1e-12)
    return float(-0.691 + 10 * torch.log10(rms))


class PinnedDrewAudio(unittest.TestCase):
    def test_length_indexes_share_brightness_and_the_speed_is_unchanged(self) -> None:
        pack_path = os.environ.get("DREW_STYLE_PACK")
        kmodel_path = os.environ.get("DREW_STYLE_KMODEL")
        if not pack_path or not kmodel_path:
            self.skipTest("private Drew weights are not on this machine")

        import torch
        from kokoro import KModel, KPipeline

        from drew import DREW_FIXED_STYLE_INDEX, drew_speed
        from style import pin_style

        pack = torch.load(pack_path, map_location="cpu", weights_only=True).float()
        model = KModel(model=kmodel_path).eval()
        pipeline = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", model=model)
        _ps, tokens = pipeline.g2p(PARAGRAPH)
        from engine import iter_phoneme_runs

        runs = [run for _g, run in iter_phoneme_runs(pipeline, tokens) if run]
        self.assertEqual(len(runs), 1, runs and [len(r) for r in runs])
        phonemes = runs[0]
        speed = drew_speed(1.0)
        self.assertEqual(speed, 1.0)

        def render(voice_pack):
            started = time.perf_counter()
            with torch.inference_mode():
                output = KPipeline.infer(model, phonemes, voice_pack, speed)
            elapsed = time.perf_counter() - started
            audio = output.audio.detach().to(dtype=torch.float32, device="cpu").reshape(-1)
            return audio, elapsed

        short = pin_style(pack, 150)
        long = pin_style(pack, 509)
        pinned = pin_style(pack, DREW_FIXED_STYLE_INDEX)
        audio_short, _t_short = render(short)
        audio_long, _t_long = render(long)
        drift = abs(_brightness(audio_short) - _brightness(audio_long))
        self.assertGreater(drift, 1.0, f"unpinned rows 150 and 509 differed by only {drift:.2f} dB")

        first, wall_a = render(pinned)
        second, wall_b = render(pinned)
        self.assertLess(abs(_brightness(first) - _brightness(second)), 1.0)
        self.assertLess(abs(_lufs_proxy(first) - _lufs_proxy(second)), 0.5)
        # The row this sentence already selects, pinned vs left indexed.
        # The vectors match. Sample identity is not required: a second call
        # on this CPU build is not bit-exact, so the check is brightness,
        # level, and wall time.
        natural = min(509, len(phonemes) - 1)
        pinned_natural = pin_style(pack, natural)
        torch.testing.assert_close(pinned_natural[len(phonemes) - 1], pack[natural])
        raw, wall_raw = render(pack)
        same, wall_same = render(pinned_natural)
        self.assertLess(abs(_brightness(raw) - _brightness(same)), 1.0)
        self.assertLess(abs(_lufs_proxy(raw) - _lufs_proxy(same)), 0.5)
        ratio = max(wall_raw, wall_same) / max(min(wall_raw, wall_same), 1e-6)
        self.assertLess(ratio, 2.0, f"same-row wall {wall_raw:.3f}s vs {wall_same:.3f}s")
        print(
            "pinned-audio",
            {
                "phonemes": len(phonemes),
                "speed": speed,
                "unpinnedBrightnessDb": round(drift, 3),
                "pinnedWall": [round(wall_a, 3), round(wall_b, 3)],
                "sameRowWall": [round(wall_raw, 3), round(wall_same, 3)],
                "sameRowPeakDiff": round(float((raw - same).abs().max()), 4),
                "sameRowBrightnessDb": round(abs(_brightness(raw) - _brightness(same)), 3),
                "naturalIndex": natural,
            },
        )


if __name__ == "__main__":
    unittest.main()
