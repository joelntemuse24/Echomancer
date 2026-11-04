"""Self-tests for the measurement code. No pytest, no GPU: `python scripts/selftest.py`.

These are the checks that must hold before any GPU job is worth running. They
pin the detector behaviour against synthetic signals whose answer is known, and
they pin the training plumbing against the checkpoint's real tensor shapes.

    python scripts/selftest.py            # everything that needs no checkpoint
    python scripts/selftest.py --model DIR  # also the checkpoint-dependent ones
"""

from __future__ import annotations

import argparse
import sys
import traceback
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

SR = 44100
HOP = 2048


def _sine(freq: float, seconds: float, amplitude: float = 0.1, sr: int = SR) -> np.ndarray:
    t = np.arange(int(seconds * sr)) / sr
    return (amplitude * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def _tick_train(seconds: float, tick_db: float = -42.0, floor_db: float = -70.0, seed: int = 0) -> np.ndarray:
    """A -70 dBFS noise floor with a 24-sample 8 kHz burst every codec frame."""
    rng = np.random.default_rng(seed)
    y = rng.standard_normal(int(seconds * SR)) * (10 ** (floor_db / 20.0))
    t = np.arange(24) / SR
    burst = np.sin(2 * np.pi * 8000 * t) * np.hanning(24) * (10 ** (tick_db / 20.0)) * 2.0
    for start in range(0, len(y) - HOP, HOP):
        y[start + 1000: start + 1024] += burst
    return y.astype(np.float32)


def test_ticks_catch_a_train():
    from audio8q.probes import detect_ticks

    report = detect_ticks(_tick_train(2.0))
    assert report.ticks >= 40, f"expected ~43 ticks, got {report.ticks}"
    assert report.spacing_mode_ms is not None and 40 <= report.spacing_mode_ms <= 55, report.spacing_mode_ms
    assert report.frame_periodic_fraction > 0.9, report.frame_periodic_fraction
    assert report.loudest_db > -48.0, report.loudest_db


def test_ticks_ignore_silence():
    from audio8q.probes import detect_ticks

    report = detect_ticks(np.zeros(SR * 2, dtype=np.float32))
    assert report.ticks == 0, report.ticks


def test_ticks_ignore_low_level_noise():
    from audio8q.probes import detect_ticks

    rng = np.random.default_rng(1)
    report = detect_ticks((rng.standard_normal(SR * 2) * 10 ** (-65 / 20.0)).astype(np.float32))
    assert report.ticks == 0, report.ticks


def test_ticks_do_not_count_speech():
    """A voiced tone with sibilant-like HF is not a tick: it is loud, so the
    pause mask excludes it."""
    from audio8q.probes import detect_ticks

    speech = _sine(220.0, 2.0, 0.2) + _sine(7000.0, 2.0, 0.05)
    assert detect_ticks(speech).ticks == 0


def test_breaths_find_a_synthetic_exhale():
    from audio8q.probes import detect_breaths

    # voiced "speech" then an unvoiced mid-band noise burst, then speech again
    speech = _sine(180.0, 1.0, 0.2)
    rng = np.random.default_rng(2)
    breath = (rng.standard_normal(int(0.35 * SR)) * 0.02).astype(np.float32)
    from audio8q.probes import band_limit

    breath = band_limit(breath, 800.0, 4500.0).astype(np.float32)
    audio = np.concatenate([speech, np.zeros(int(0.05 * SR), dtype=np.float32), breath, np.zeros(int(0.05 * SR), np.float32), speech])
    report = detect_breaths(audio)
    assert report.total >= 1, "no breath found in an obvious synthetic exhale"
    assert any(c.dur >= 0.15 for c in report.candidates), [c.dur for c in report.candidates]


def test_breaths_ignore_pure_silence():
    from audio8q.probes import detect_breaths

    assert detect_breaths(np.zeros(SR * 2, dtype=np.float32)).total == 0


def test_frame_grid_matches_the_codec():
    from audio8q.frames import FRAME_MS, HOP as H, SAMPLE_RATE

    assert SAMPLE_RATE == 44100 and H == 2048
    assert abs(FRAME_MS - 46.44) < 0.01, FRAME_MS


def test_wer_normalisation():
    from audio8q.evalharness import score_wer

    perfect = score_wer("Hello there, this is a test.", "hello there this is a test")
    assert perfect["wer"] == 0.0, perfect
    one_word = score_wer("Hello there this is the test.", "hello there this is a test")
    assert one_word["substitutions"] == 1, one_word


def test_compare_applies_the_acceptance_targets():
    from audio8q.evalharness import Take, compare

    def take(variant, breath, ah, ticks, wer, sim):
        return Take(
            name=f"{variant}-1", text_id="t", wav="x.wav", variant=variant,
            breath_candidates=breath, pause_ah=ah, ticks_per_pause_minute=ticks,
            wer=wer, speaker_similarity=sim, audio_seconds=30.0,
        )

    baseline = [take("base", 20, 5, 12.0, 0.02, 0.85) for _ in range(3)]
    good = [take("fix", 4, 0, 0.5, 0.025, 0.84) for _ in range(3)]
    bad = [take("fix", 18, 4, 11.0, 0.02, 0.80) for _ in range(3)]
    assert compare(baseline, good)["ok"] is True
    verdict = compare(baseline, bad)
    assert verdict["ok"] is False
    assert verdict["checks"]["breath_candidates"]["pass_"] is False
    assert verdict["checks"]["speaker_similarity"]["pass_"] is False


def test_dataset_debreathing_removes_the_breath_it_finds():
    from audio8q import dataprep
    from audio8q.probes import band_limit, detect_breaths

    speech = _sine(180.0, 1.0, 0.2)
    rng = np.random.default_rng(3)
    breath = band_limit((rng.standard_normal(int(0.4 * SR)) * 0.02), 800.0, 4500.0).astype(np.float32)
    audio = np.concatenate([speech, breath, speech])
    before = detect_breaths(audio).total
    cleaned, info = dataprep.remove_breaths(audio)
    after = detect_breaths(cleaned).total
    assert before >= 1, "test signal has no detectable breath"
    assert after < before, (before, after, info)
    assert info["edits"] >= 1


def test_lora_shape_maths_no_checkpoint():
    """LoRALinear must be identity at init and shape-correct after a step."""
    import torch
    from audio8q.train_lora import LoRALinear

    base = torch.nn.Linear(16, 8, bias=True)
    layer = LoRALinear(base, rank=4, alpha=8.0)
    x = torch.randn(3, 16)
    assert torch.allclose(layer(x), base(x)), "LoRA must start as a no-op"
    with torch.no_grad():
        layer.lora_b.weight.normal_()
    assert not torch.allclose(layer(x), base(x)), "LoRA had no effect after touching B"
    assert layer(x).shape == (3, 8)


def test_checkpoint_dependent(model_dir: str):
    """Checks that need the real weights: hooks, the frame/token mapping, and
    one training step. These are the failures that would otherwise only show up
    after a GPU container has booted."""
    import torch

    from audio8q import codec_tools as CT
    from audio8q import steering, train_lora
    from audio8q.frames import frame_db

    from transformers import AutoModel, AutoProcessor

    processor = AutoProcessor.from_pretrained(model_dir, trust_remote_code=True)
    model = AutoModel.from_pretrained(model_dir, trust_remote_code=True, dtype=torch.float32).eval()

    # 1. the codec round-trips and reports a frame grid of 2048 samples
    ctx = CT.codec_context(model)
    codes = ctx.encode(_sine(220.0, 1.0, 0.1))
    audio = ctx.decode(codes)
    assert codes.shape[0] == model.config.num_codebooks, codes.shape
    assert len(audio) == codes.shape[1] * HOP, (len(audio), codes.shape[1] * HOP)

    # 2. the encoder's own silence latents decode to something far quieter than speech
    silence = np.zeros(SR, dtype=np.float32)
    silence_codes = ctx.encode(silence)
    decoded = ctx.decode(silence_codes)
    assert float(np.abs(decoded).max()) < 0.01, float(np.abs(decoded).max())
    assert frame_db(decoded).max() < -40.0

    # 3. the slow-AR hook fires once per generated frame and the hidden width matches
    ref_codes = codes[:, :60]
    text = "The lamp was still burning when he came back."
    audio_out, out_codes, hidden = steering.capture_lm_head_input(
        model, text, processor, ref_codes, "The lamp was still burning.", dict(seed=1, max_new_tokens=32)
    )
    assert hidden.shape[0] >= 1 and hidden.shape[1] == model.config.dim, hidden.shape
    assert hidden.shape[0] <= out_codes.shape[1], (hidden.shape, out_codes.shape)
    assert len(audio_out) > 0

    # 4. labels cover the whole take and include speech
    labels = steering.label_frames(audio_out)
    assert int((labels.labels == "speech").sum()) > 0, labels.counts()

    # 5. a steering hook changes the output but keeps the shape
    direction = np.ones(model.config.dim, dtype=np.float32)
    direction /= np.linalg.norm(direction)
    hook = steering.SteeringHook(direction, alpha=1.0, mode="clamp", threshold=0.0)
    audio_steered, _, _ = steering.capture_lm_head_input(
        model, text, processor, ref_codes, "The lamp was still burning.", dict(seed=1, max_new_tokens=32), hook=hook
    )
    assert audio_steered.shape != audio_out.shape or not np.allclose(audio_steered, audio_out)

    # 6. generation left KV caches on the attention layers; clearing them is what
    #    lets a training forward pass run in the same process
    cleared = train_lora.detach_generation_caches(model)
    assert cleared == model.config.n_layer + model.config.n_fast_layer, cleared

    # 7. one LoRA step runs and produces finite gradients
    info = train_lora.inject_lora(model, rank=4, alpha=8.0)
    assert info["replaced_modules"] > 0
    assert info["trainable_params"] < 20_000_000, info
    example = train_lora.build_example(
        model, processor, ctx.encode(_sine(180.0, 0.6, 0.15)), "A short line.", ref_codes, "The lamp was still burning."
    )
    model.train()
    loss = train_lora.semantic_loss(model, example)
    loss.backward()
    assert torch.isfinite(loss), loss
    grads = [p.grad for p in train_lora.trainable_parameters(model) if p.grad is not None]
    assert grads and all(torch.isfinite(g).all() for g in grads)
    train_lora.merge_lora(model)
    assert not any(type(m).__name__ == "LoRALinear" for m in model.modules())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="", help="checkpoint dir for the model-dependent tests")
    args = parser.parse_args()

    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and k != "test_checkpoint_dependent"]
    if args.model:
        tests.append(lambda: test_checkpoint_dependent(args.model))

    failures = 0
    for fn in tests:
        name = getattr(fn, "__name__", "test_checkpoint_dependent")
        try:
            fn()
            print(f"ok    {name}")
        except Exception:
            failures += 1
            print(f"FAIL  {name}")
            traceback.print_exc()
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
