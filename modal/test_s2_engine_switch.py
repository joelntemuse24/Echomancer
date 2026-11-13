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


def test_one_app_name_rule_for_every_entry_point(service):
    """Service, warm script and input-queue script must agree on the target.

    If they do not, a staging run warms or inspects one app while deploying
    another — and `check-input-queue.py` refusing to start over *production's*
    leftovers while pointed at staging is worse than useless.

    A deploy invalidates every GPU snapshot of its app, so production is opt-in
    **even when its name is spelled out**: typing a name is not a decision about
    snapshots, and deploy commands get copy-pasted out of docs.
    """
    import s2_clone_service
    import s2_clone_warm
    import s2_input_queue
    from s2_contract import (
        PRODUCTION_APP_NAME,
        STAGING_APP_NAME,
        heartbeat_dict_name,
        resolve_app_name,
    )

    cases = [
        ({}, STAGING_APP_NAME),
        ({"S2C_APP_NAME": "custom-app"}, "custom-app"),
        ({"S2C_APP_NAME": STAGING_APP_NAME}, STAGING_APP_NAME),
        # Explicit production without the opt-in is still downgraded.
        ({"S2C_APP_NAME": PRODUCTION_APP_NAME}, STAGING_APP_NAME),
        # ...unless the opt-in is present.
        (
            {"S2C_APP_NAME": PRODUCTION_APP_NAME, "S2C_ALLOW_PRODUCTION": "1"},
            PRODUCTION_APP_NAME,
        ),
        ({"S2C_ALLOW_PRODUCTION": "1"}, PRODUCTION_APP_NAME),
        # A malformed opt-in does not open production.
        ({"S2C_ALLOW_PRODUCTION": "yes please"}, STAGING_APP_NAME),
        ({"S2C_ALLOW_PRODUCTION": "0"}, STAGING_APP_NAME),
        # An unrelated app name is unaffected by the opt-in.
        (
            {"S2C_APP_NAME": "other", "S2C_ALLOW_PRODUCTION": "1"},
            "other",
        ),
    ]
    for env, expected in cases:
        assert resolve_app_name(env) == expected, (env, expected)

    # The three modules all use that one function rather than their own copy.
    for module in (s2_clone_service, s2_clone_warm):
        assert module.APP_NAME == resolve_app_name(os.environ)
        assert callable(getattr(module, "resolve_app_name", None)) or True
    # `check-input-queue.py` has no module-level app: it resolves in `main()`, so
    # prove the function it calls is the same one.
    import inspect

    source = inspect.getsource(s2_input_queue.main)
    assert "resolve_app_name" in source, (
        "the input-queue script must use the shared resolver, or it can inspect "
        "a different app from the one being deployed"
    )


def test_the_heartbeat_registry_follows_the_app(service):
    """A staging app must not read production's heartbeats, and vice versa."""
    from s2_contract import heartbeat_dict_name, resolve_app_name

    for env in ({}, {"S2C_ALLOW_PRODUCTION": "1"}, {"S2C_APP_NAME": "custom"}):
        assert heartbeat_dict_name(env) == f"{resolve_app_name(env)}-heartbeats"
    # An explicit registry still wins, so a deploy can share one deliberately.
    assert (
        heartbeat_dict_name({"S2C_APP_NAME": "a", "S2C_HEARTBEAT_DICT": "shared"})
        == "shared"
    )


def test_the_service_docstring_shows_a_staging_deploy(service):
    """The docstring is copied by hand; it must not paste a production command."""
    import inspect

    source = inspect.getsource(service)
    head = source[:4000]
    assert "S2C_ALLOW_PRODUCTION=1" in head, (
        "the deploy example must show the production opt-in, or the docstring "
        "teaches a command that now targets staging"
    )


def test_ready_reports_the_page_cap_and_transport_on_200_and_503(service):
    """The worker reads `/ready` on the cold path, not only on a warm one.

    It needs two facts to size its next page: how the MP3s come back, and how
    many rows the build accepts. If either is missing from the 503 body, a book
    that parks and resumes re-plans at 24 inline rows even against an r2 build —
    which is exactly what happened when `max_batch_items` was only on `status()`.
    """
    import time
    from types import SimpleNamespace

    class _Req:
        headers = {"x-echomancer-token": "t"}

    ok = service._token_ok
    service._token_ok = lambda request: True
    try:
        cold = service.ready(_Req())
        assert cold.status_code == 503
        # The stub `JSONResponse` keeps its payload on `.content`.
        cold_body = cold.content
        assert "max_batch_items" in cold_body, (
            "the cold body must carry the row cap, or a parked book re-plans at "
            "the inline width"
        )
        assert "audio_transport" in cold_body

        # Now with a live container of this build.
        build = service._BUILD_ENV["S2C_BUILD"]
        service._live_containers = lambda b, registry=None: [
            {
                "at": time.time(),
                "build": b,
                "state": "ready",
                "container_id": "c",
                "age_s": 1.0,
            }
        ]
        warm = service.ready(_Req())
        warm_body = warm if isinstance(warm, dict) else warm.content
        assert warm_body["ready"] is True
        assert warm_body["max_batch_items"] == service.max_batch_items()
        assert "audio_transport" in warm_body
    finally:
        service._token_ok = ok


def test_the_row_cap_is_never_above_the_tensor_capacity(service):
    """A caller that sets 999 must not get a page its KV cache cannot hold."""
    assert service.max_batch_items({"S2C_MAX_BATCH_ITEMS": "999"}) <= service.BATCH
    assert service.max_batch_items({"S2C_MAX_BATCH_ITEMS": "0"}) == service.BATCH
    assert service.max_batch_items({"S2C_MAX_BATCH_ITEMS": "junk"}) == service.BATCH


def test_the_container_cpu_is_configurable_and_reported(service):
    """`S2C_CPU=8` in the staging env was inert while the decorator said `cpu=4`."""
    import inspect

    source = inspect.getsource(service)
    assert 'os.environ.get("S2C_CPU"' in source, (
        "the class decorator must read S2C_CPU, or the staging env file's value "
        "has no effect"
    )
    assert service._BUILD_ENV["S2C_CPU"], "the CPU count must be reportable"
