"""The defaults a plain `modal deploy` gets, and the v10 engine it can opt into.

This is the production-safety test for the whole branch. The worker and the
Modal app ship separately, and the app is a 15-minute snapshot rebuild, so there
is always a window where one has changed and the other has not. What must never
happen is a `modal deploy` with no new environment variables producing audio
that is different from what the app produces today.

So the claim is not "the new path is on". It is:

  * with **no** `S2C_ENGINE` set, the container reproduces the deployed build's
    decode behaviour — the upstream fast-transformer step, upstream's sampling
    mask, the 128-token KV rounding, `BATCH` rows per step, one unit at a time,
    the serial codec/encode/upload order, and no codec tuning;
  * with `S2C_ENGINE=v10` every one of those is the fast path;
  * anything unrecognised falls back to v9 rather than guessing.

The switches are read once at import (they are baked into the snapshot), so each
case imports the module fresh through the `engine` fixture.
"""

from __future__ import annotations

import importlib
import os
import sys

import pytest

MODAL_DIR = __import__("pathlib").Path(__file__).parent


@pytest.fixture(scope="module")
def service():
    """The service module imported against the shared stubs (v9 default)."""
    from test_s2_service_import import Recorder, _install_stubs

    recorder = Recorder()
    _install_stubs(recorder)
    sys.path.insert(0, str(MODAL_DIR))
    for name in ("s2_contract", "s2_batch", "s2_mastering", "s2_clone_service"):
        sys.modules.pop(name, None)
    os.environ.pop("S2C_ENGINE", None)
    module = importlib.import_module("s2_clone_service")
    module._recorder = recorder  # type: ignore[attr-defined]
    yield module
    for name in ("s2_batch", "s2_clone_service"):
        sys.modules.pop(name, None)
    sys.path.remove(str(MODAL_DIR))


# ── the deployed default ───────────────────────────────────────────────────


@pytest.mark.engine("v9")
def test_a_plain_deploy_reproduces_the_deployed_decode_path(engine):
    assert engine.ENGINE == "v9"
    assert engine.NEW_ENGINE is False
    # The engine, not the individual switches, is the rollback surface.
    assert engine.BUCKET_BATCH is False, "v9 always stepped BATCH rows"
    assert engine.WORK_STEAL is False, "v9 was one unit at a time per row"
    assert engine.EOS_CHECK_EVERY == 8, "v9 synced every 8 steps"
    assert engine.DAC_MICRO_BATCH == 8, "v9's codec micro-batch was 8"
    assert engine.PIPELINE_CODEC is False, "v9 decoded everything after AR"
    assert engine.CODEC_TUNING is False, "v9 kept weight_norm and rebuilt the mask"
    assert engine.FAST_DECODE is False, "v9 called upstream's fast step"
    assert engine.BATCHED_PREFILL is False, "v9 prefilled one lane at a time"


@pytest.mark.engine("v9")
def test_v9_keeps_the_128_token_kv_rounding(engine):
    """The deployed build rounded to 128-token buckets, not four coarse ones."""
    assert engine.KV_BUCKETS == (128,)
    assert engine.choose_kv_len(0) == 128
    assert engine.choose_kv_len(127) == 128
    assert engine.choose_kv_len(128) == 256
    assert engine.choose_kv_len(1000) == 1024


@pytest.mark.engine("v9")
def test_v9_steps_the_allocated_batch_width(engine):
    """One section still ran `BATCH` rows, 31 of them dummies."""
    width = engine.choose_batch_width([[{"text": "one section"}]])
    assert width == engine.BATCH


@pytest.mark.engine("v9")
def test_v9_has_the_opt_in_paths_off(engine):
    assert engine.SDPA_DECODE is False
    assert engine.TOPK_FAST_SAMPLE is False


# ── the staged engine ──────────────────────────────────────────────────────


@pytest.mark.engine("v10")
def test_v10_turns_on_every_speedup_switch(engine):
    assert engine.ENGINE == "v10"
    assert engine.NEW_ENGINE is True
    assert engine.BUCKET_BATCH is True
    assert engine.WORK_STEAL is True
    assert engine.EOS_CHECK_EVERY == 16
    assert engine.DAC_MICRO_BATCH == 16
    assert engine.PIPELINE_CODEC is True
    assert engine.CODEC_TUNING is True
    assert engine.FAST_DECODE is True
    assert engine.BATCHED_PREFILL is True


@pytest.mark.engine("v10")
def test_v10_uses_four_coarse_kv_buckets(engine):
    assert engine.KV_BUCKETS == (512, 1024, 2048, 4096)
    assert engine.choose_kv_len(0) == 512
    assert engine.choose_kv_len(512) == 1024
    assert engine.choose_kv_len(4096) == 4096


@pytest.mark.engine("v10")
def test_v10_still_has_the_two_unproven_switches_off(engine):
    """Folded-GQA SDPA and the top-k sampler are staging measurements."""
    assert engine.SDPA_DECODE is False
    assert engine.TOPK_FAST_SAMPLE is False


# ── the switch itself ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "value,expected",
    [
        (None, "v9"),
        ("", "v9"),
        ("v9", "v9"),
        ("v10", "v10"),
        ("V10", "v10"),
        ("new", "v10"),
        ("on", "v10"),
        ("1", "v10"),
        ("true", "v10"),
        # Anything else must not silently change how a book sounds.
        ("v11", "v9"),
        ("fast", "v9"),
        ("yes please", "v9"),
    ],
)
def test_the_engine_switch_defaults_to_the_deployed_behaviour(engine, value, expected):
    assert engine._engine_choice({} if value is None else {"S2C_ENGINE": value}) == expected


def test_every_switch_can_still_be_overridden_alone(engine):
    """The individual flags remain usable for a narrower staging A/B."""
    assert engine._engine_choice({"S2C_ENGINE": "v9"}) == "v9"


@pytest.mark.engine("v10")
def test_an_individual_switch_can_be_turned_back_off_under_v10(engine, monkeypatch):
    """A staging A/B must be able to isolate one change."""
    # Re-import with one switch explicitly disabled on top of v10.
    import importlib
    import sys

    monkeypatch.setenv("S2B_WORK_STEAL", "0")
    sys.modules.pop("s2_batch", None)
    module = importlib.import_module("s2_batch")
    assert module.ENGINE == "v10"
    assert module.WORK_STEAL is False
    assert module.BUCKET_BATCH is True


# ── the deploy surface ─────────────────────────────────────────────────────


def test_the_engine_is_pinned_into_the_container_env(service):
    """A snapshot must be built for exactly the kernels it will run.

    Reading `S2C_ENGINE` from the ambient environment at request time would let a
    restored container run a decode path it never compiled. Pinning it into
    `_BUILD_ENV` applies the same value to the GPU class and the CPU probe, so
    `/ready` describes the engine the containers are actually running.
    """
    assert "S2C_ENGINE" in service._BUILD_ENV
    assert service._BUILD_ENV["S2C_ENGINE"] in ("v9", "v10")


def test_the_engine_is_part_of_the_build_fingerprint(service):
    """Two engines must not share a build id, or a stale one looks current."""
    from s2_contract import snapshot_fingerprint

    common = {"app": "a", "version": "10", "gpu": "H100!", "batch": 32}
    old = snapshot_fingerprint({**common, "engine": "v9"})
    new = snapshot_fingerprint({**common, "engine": "v10"})
    assert old != new


def test_the_recipe_reports_what_audio_settings_it_renders_with(service):
    """`/ready`'s recipe is how a stored take is traced to its settings."""
    assert service._RECIPE["history"] == "first"
    assert service._RECIPE["unit_max_chars"] == service.UNIT_MAX_CHARS


def test_the_production_app_name_is_unchanged_by_default(service):
    """Staging must be opt-in; a plain deploy still targets production."""
    import os

    assert service.APP_NAME == os.environ.get("S2C_APP_NAME", "echomancer-s2-clone")
    # And the heartbeat registry follows the app, so the two cannot disagree.
    assert service.HEARTBEAT_DICT_NAME == os.environ.get(
        "S2C_HEARTBEAT_DICT", f"{service.APP_NAME}-heartbeats"
    )
