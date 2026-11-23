"""A reference clip must not be silently shortened inside the prompt.

Staging saw `truncated_units: 2` — the model's frame cap cutting a *generated*
section. The same class of cut exists on the **input** side and is worse, because
nothing reports it: a reference becomes codebook frames at `44100/2048` ~ 21.5
frames/s, the whole prompt has to fit `MAX_SEQ_LEN` (4096), and past that the
prompt is quietly shortened. The model is then conditioned on a different clip
than the one that was uploaded, and the clone drifts with no error anywhere.

These tests pin the two failures that are now loud:

  * a clip longer than the cap (a product error: trim the clip);
  * a clip inside the cap that still leaves no frames to generate
    (a packing error: this catches it before any GPU time is spent).
"""

from __future__ import annotations

import importlib
import sys

import pytest

MODAL_DIR = __import__("pathlib").Path(__file__).parent


@pytest.fixture(scope="module")
def batch():
    """`s2_batch` with the Modal API stubbed, to read the engine's frame cap."""
    from test_s2_service_import import Recorder, _install_stubs

    _install_stubs(Recorder())
    sys.path.insert(0, str(MODAL_DIR))
    sys.modules.pop("s2_batch", None)
    module = importlib.import_module("s2_batch")
    yield module
    sys.path.remove(str(MODAL_DIR))
    for name in ("s2_batch", "s2_contract", "s2_mastering", "s2_clone_service"):
        sys.modules.pop(name, None)


@pytest.fixture(scope="module")
def contract():
    sys.path.insert(0, str(MODAL_DIR))
    sys.modules.pop("s2_contract", None)
    module = importlib.import_module("s2_contract")
    yield module
    sys.path.remove(str(MODAL_DIR))
    sys.modules.pop("s2_contract", None)


def test_the_cap_is_twenty_seconds(contract):
    """The middle of the 10-40 s range the YouTube picker already produces."""
    assert contract.REFERENCE_MAX_SECONDS == 20.0


def test_frames_follow_the_codec_ratio(contract):
    """`44100 / 2048` ~ 21.5 frames/s, the ratio MAX_NEW_FRAMES is set against."""
    assert contract.REFERENCE_FRAMES_PER_SECOND == pytest.approx(21.53, abs=0.01)
    assert contract.reference_prompt_frames(1.0) == 22
    assert contract.reference_prompt_frames(20.0) == 431
    assert contract.reference_prompt_frames(0) == 0
    assert contract.reference_prompt_frames(-1) == 0


def test_a_twenty_second_reference_leaves_room_for_the_widest_unit(contract):
    """The cap must be *usable*: 20 s plus a 560-char unit must still generate."""
    detail = contract.validate_reference_duration(
        20.0,
        unit_chars=contract.UNIT_MAX_CHARS,
        reserve_frames=contract.REFERENCE_RESERVE_FRAMES,
    )
    assert detail["remaining"] >= contract.REFERENCE_RESERVE_FRAMES
    # And with room to spare, not just on the line.
    assert detail["remaining"] > contract.REFERENCE_RESERVE_FRAMES


def test_a_clip_past_the_cap_is_rejected_loudly(contract):
    with pytest.raises(contract.ReferenceTooLongError) as caught:
        contract.validate_reference_duration(45.0)
    message = str(caught.value)
    # The message has to say what to do, because the fix is the operator's.
    assert "45.0s" in message
    assert "20s" in message
    assert "Trim" in message
    # And it is a reference-clip error, so the handler answers 422, not 500.
    assert isinstance(caught.value, contract.ReferenceClipError)


def test_the_cap_itself_is_allowed(contract):
    """Exactly at the cap is fine; the check is `>`, not `>=`."""
    contract.validate_reference_duration(contract.REFERENCE_MAX_SECONDS)


def test_a_reference_that_starves_the_generation_is_rejected(contract):
    """A clip inside the cap but with no room left is a packing error, not a product one."""
    with pytest.raises(contract.ReferenceClipError) as caught:
        contract.validate_reference_duration(
            20.0, max_seq_len=400, reserve_frames=contract.REFERENCE_RESERVE_FRAMES
        )
    message = str(caught.value)
    assert "no room to generate" in message
    # The numbers are in the message, so an operator can see which side is wrong.
    assert "ref_frames" not in message  # it is prose, not a dict dump
    assert "of 400" in message


def test_a_huge_unit_text_also_starves_and_is_caught(contract):
    """The unit's text is part of the prompt; a long one can starve it alone."""
    with pytest.raises(contract.ReferenceClipError):
        contract.validate_reference_duration(
            20.0,
            unit_chars=200_000,
            reserve_frames=contract.REFERENCE_RESERVE_FRAMES,
        )


def test_a_short_clip_is_accepted_with_plenty_of_room(contract):
    detail = contract.validate_reference_duration(
        10.0,
        unit_chars=contract.UNIT_MAX_CHARS,
        reserve_frames=contract.REFERENCE_RESERVE_FRAMES,
    )
    assert detail["remaining"] > contract.reference_prompt_frames(10.0)


def test_a_missing_duration_is_rejected_not_ignored(contract):
    """An unknown duration cannot be proven to fit, so it does not pass."""
    with pytest.raises(contract.ReferenceClipError):
        contract.validate_reference_duration(None)


def test_history_frames_are_counted(contract):
    """A second unit carries the row's first take; that is prompt too."""
    loose = contract.reference_fits_prompt(20.0, unit_chars=560, reserve_frames=1024)[1]
    tight = contract.reference_fits_prompt(
        20.0, unit_chars=560, history_frames=800, reserve_frames=1024
    )[1]
    assert tight["used"] == loose["used"] + 800
    assert tight["remaining"] == loose["remaining"] - 800


def test_the_reserve_is_the_widest_legal_unit(contract, batch):
    """`MAX_NEW_FRAMES` is the ceiling a single unit can run to.

    The reserve has to be at least that, or a passing check could still leave a
    legal unit with nowhere to generate. It is read from `s2_batch` rather than
    `s2_contract`, because the frame cap belongs to the engine.
    """
    assert contract.REFERENCE_RESERVE_FRAMES >= batch.MAX_NEW_FRAMES


def test_fits_prompt_reports_numbers_for_a_log_line(contract):
    fits, detail = contract.reference_fits_prompt(
        20.0, unit_chars=560, reserve_frames=1024
    )
    assert fits is True
    for field in (
        "seconds",
        "ref_frames",
        "text_tokens",
        "history_frames",
        "fixed_tokens",
        "used",
        "remaining",
        "reserve_frames",
        "max_seq_len",
    ):
        assert field in detail, field


def test_the_handler_validates_duration_before_any_gpu_work(contract):
    """The check has to run where it costs nothing, not inside `encode_reference`."""
    source = (MODAL_DIR / "s2_clone_service.py").read_text(encoding="utf-8")
    body = source[source.index("def _synthesize_batch_body"):]
    reference_check = body.index("validate_reference_audio(audio)")
    duration_check = body.index("validate_reference_duration(")
    gpu_work = body.index("def gpu_work()")
    assert reference_check < duration_check < gpu_work, (
        "duration must be validated with the rest of the reference checks, "
        "before the GPU thread is asked to do anything"
    )
