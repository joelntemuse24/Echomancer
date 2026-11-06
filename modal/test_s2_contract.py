"""Offline tests for the S2 contract helpers — no GPU, no Modal, no network.

    python3 -m pytest modal -q

The rules tested here are the ones that cost a snapshot build or a customer
book: an empty reference clip killed the October warm-up, and an empty
transcript silently stops Fish from cloning at all.
"""

from __future__ import annotations

import math
import struct
import wave

import pytest

from s2_contract import (
    REFERENCE_MAX_BYTES,
    REFERENCE_MIN_BYTES,

    PAUSE_MAX_S,
    SPLIT_PAUSE_S,
    UNIT_TARGET_CHARS,
    ReferenceClipError,
    ReferenceTextError,
    SamplingError,
    WARM_REFERENCE_TEXT,
    container_limits,
    history_anchor,
    inserted_pause_s,
    parse_sampling,
    plan_lane_sections,
    reference_stats,
    seed_for_call,
    COMPILE_WALL_S,
    RESTORE_WALL_S,
    placement_kind,
    snapshot_fingerprint,
    validate_reference_audio,
    validate_reference_text,
    warm_reference_wav,
)


def _wav(samples: list[int], rate: int = 44100, channels: int = 1) -> bytes:
    import io

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    return buf.getvalue()


def _speech_like(seconds: float = 3.0, rate: int = 44100) -> bytes:
    frames = int(seconds * rate)
    samples = [
        int(20000 * math.sin(2 * math.pi * 180 * i / rate)) for i in range(frames)
    ]
    return _wav(samples, rate)


def _encode(codec: str, seconds: float, *, silence: bool = False, rate: int = 44100) -> bytes:
    """Encode a real clip with ffmpeg, the way the worker's references arrive.

    Uses the same ffmpeg the container has. `silence=True` writes digital
    silence, whose bytes are still full of frame headers — which is why the
    byte-level checks could never reject it.
    """
    import shutil
    import subprocess

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        pytest.skip("ffmpeg is not on PATH")
    args = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    if silence:
        args += ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", str(seconds)]
        audio = b""
    else:
        args += ["-f", "s16le", "-ar", str(rate), "-ac", "1", "-i", "pipe:0"]
        # Skip the 44-byte RIFF header: these are raw samples on stdin.
        audio = _speech_like(seconds, rate)[44:]
    args += ["-t", str(seconds), "-f", codec, "pipe:1"]
    proc = subprocess.run(
        args, input=audio, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120
    )
    if proc.returncode != 0 or not proc.stdout:
        pytest.skip(f"ffmpeg cannot encode {codec}: {proc.stderr.decode()[:200]}")
    return proc.stdout


class TestWarmReference:
    def test_is_a_valid_prompt_clip(self):
        audio = warm_reference_wav()
        stats = validate_reference_audio(audio)
        # The warm-up must never need a real file on the snapshot machine.
        assert stats["format"] == "wav"
        assert stats["seconds"] >= 1.0
        assert stats["rms"] > 0.01
        assert len(audio) >= REFERENCE_MIN_BYTES

    def test_is_deterministic(self):
        assert warm_reference_wav() == warm_reference_wav()

    def test_transcript_is_not_a_placeholder(self):
        assert validate_reference_text(WARM_REFERENCE_TEXT) == WARM_REFERENCE_TEXT


class TestReferenceAudio:
    def test_rejects_an_empty_clip_by_name(self):
        # This is exactly what broke the saved snapshot: a 0-byte file.
        with pytest.raises(ReferenceClipError) as err:
            validate_reference_audio(b"")
        assert "empty" in str(err.value)

    def test_rejects_a_clip_that_is_too_small(self):
        with pytest.raises(ReferenceClipError) as err:
            validate_reference_audio(b"\x01\x02" * 100)
        assert "at least" in str(err.value)

    def test_rejects_a_clip_over_the_upload_cap(self):
        with pytest.raises(ReferenceClipError) as err:
            validate_reference_audio(b"\x01" * (REFERENCE_MAX_BYTES + 1))
        assert "cap" in str(err.value)

    def test_rejects_a_zero_filled_clip(self):
        with pytest.raises(ReferenceClipError) as err:
            validate_reference_audio(bytes(REFERENCE_MIN_BYTES * 2))
        assert "zero bytes" in str(err.value)

    def test_rejects_a_digital_silence_wav(self):
        silence = _wav([0] * 44100 * 3)
        with pytest.raises(ReferenceClipError) as err:
            validate_reference_audio(silence)
        assert "silent" in str(err.value)

    def test_rejects_a_flat_line_waveform(self):
        flat = _wav([1234] * 44100 * 3)
        with pytest.raises(ReferenceClipError) as err:
            validate_reference_audio(flat)
        assert "flat-line" in str(err.value)

    def test_rejects_a_clip_shorter_than_the_floor(self):
        short = _wav([5000, -5000] * 200)
        with pytest.raises(ReferenceClipError) as err:
            validate_reference_audio(short)
        assert "0.3" in str(err.value) or "s;" in str(err.value)

    def test_accepts_a_real_prompt_clip(self):
        stats = validate_reference_audio(_speech_like(3.0))
        assert stats["seconds"] == pytest.approx(3.0, abs=0.01)
        assert stats["peak"] > 0.3

    def test_reads_a_stereo_clip(self):
        rate = 44100
        frames = rate * 2
        interleaved = [
            int(18000 * math.sin(2 * math.pi * 220 * i / rate)) for i in range(frames)
        ]
        stereo = _wav(
            [v for v in interleaved for _ in range(2)], rate=rate, channels=2
        )
        stats = validate_reference_audio(stereo)
        assert stats["seconds"] == pytest.approx(2.0, abs=0.02)

    def test_decodes_a_non_wav_container_instead_of_passing_it_unchecked(self):
        """The production regression, at the validation layer.

        `job 5f09ee0e` sent an MP3 reference and `validate_reference_audio`
        waved it through as `"opaque"` (`seconds: None`), so every silence and
        length rule was skipped and the failure only surfaced later as an HTTP
        500 from `av.open(..., metadata_errors="ignore")`. A non-WAV clip must
        now be decoded here, before any GPU work, so the same rules apply.
        """
        mp3 = _encode("mp3", 3.0)
        stats = validate_reference_audio(mp3)
        assert stats["format"] == "decoded"
        assert stats["container"] == "mp3"
        assert stats["seconds"] == pytest.approx(3.0, abs=0.15)
        assert stats["rms"] > 0.05

    def test_rejects_a_silent_mp3(self):
        # Byte checks alone cannot see this: an MP3 of digital silence has
        # plenty of nonzero bytes (frame headers), so only decoded amplitude
        # tells the truth.
        silence = _encode("mp3", 3.0, silence=True)
        with pytest.raises(ReferenceClipError) as err:
            validate_reference_audio(silence)
        assert "silent" in str(err.value)

    def test_names_the_container_when_a_reference_cannot_be_decoded(self):
        payload = b"ID3" + bytes(range(1, 250)) * 200
        with pytest.raises(ReferenceClipError) as err:
            validate_reference_audio(payload)
        message = str(err.value)
        assert "mp3" in message
        # The type error this replaced said nothing about the input.
        assert "metadata_errors" not in message
        assert "av.open" not in message

    def test_stats_never_raise_on_a_truncated_wav(self):
        audio = _speech_like(1.0)[:60]
        stats = reference_stats(audio)
        assert stats["bytes"] == len(audio)


class TestReferenceText:
    @pytest.mark.parametrize("text", ["", "   ", ".", "...", "n/a", "none", "null"])
    def test_rejects_placeholders(self, text):
        with pytest.raises(ReferenceTextError):
            validate_reference_text(text)

    def test_rejects_text_with_no_letters(self):
        with pytest.raises(ReferenceTextError):
            validate_reference_text("--- *** ---")

    def test_trims_and_returns_real_text(self):
        assert validate_reference_text("  Hello there.  ") == "Hello there."


class TestSampling:
    def test_parses_the_default(self):
        assert parse_sampling("") == (0.9, 0.9)
        assert parse_sampling(None) == (0.9, 0.9)

    def test_parses_a_pair(self):
        assert parse_sampling("0.7, 0.8") == (0.7, 0.8)

    @pytest.mark.parametrize("raw", ["0.9", "a,b", "0.9,0.9,0.9", "0,0.9", "3,0.9"])
    def test_rejects_malformed_values(self, raw):
        with pytest.raises(SamplingError):
            parse_sampling(raw)


class TestLanePlanning:
    def test_fills_lanes_round_robin(self):
        sections = ["x" * 100] * 8
        lanes = plan_lane_sections(sections, lanes=4, batch=24, max_tick_chars=1000)
        assert len(lanes) == 4
        assert sum(len(lane) for lane in lanes) == 8

    def test_never_exceeds_the_batch(self):
        lanes = plan_lane_sections(["x" * 10] * 10, lanes=2, batch=3, max_tick_chars=10_000)
        assert all(len(lane) <= 3 for lane in lanes)
        assert sum(len(lane) for lane in lanes) == 6

    def test_returns_only_used_lanes(self):
        lanes = plan_lane_sections(["x" * 10], lanes=4, batch=24, max_tick_chars=1000)
        assert len(lanes) == 1

    def test_rejects_zero_lanes(self):
        with pytest.raises(ValueError):
            plan_lane_sections(["x"], lanes=0, batch=1, max_tick_chars=10)


class TestSnapshotIdentity:
    def test_is_stable_for_the_same_config(self):
        cfg = {"gpu": "H100!", "batch": 32, "version": "5"}
        assert snapshot_fingerprint(cfg) == snapshot_fingerprint(dict(cfg))

    def test_changes_when_the_config_changes(self):
        base = snapshot_fingerprint({"gpu": "H100!", "batch": 32})
        assert base != snapshot_fingerprint({"gpu": "H100!", "batch": 24})
        assert base != snapshot_fingerprint({"gpu": "A100", "batch": 32})

    def test_is_short_enough_to_log(self):
        assert len(snapshot_fingerprint({"a": 1})) == 12


class TestSeeding:
    def test_is_deterministic_for_one_call(self):
        assert seed_for_call("job", "0", 0) == seed_for_call("job", "0", 0)

    def test_differs_between_sections_and_jobs(self):
        assert seed_for_call("job", "0", 0) != seed_for_call("job", "1", 0)
        assert seed_for_call("job-a", "0", 0) != seed_for_call("job-b", "0", 0)

    def test_differs_on_a_retry_so_the_take_is_not_replayed(self):
        assert seed_for_call("job", "0", 0) != seed_for_call("job", "0", 1)

    def test_stays_in_torch_range(self):
        for epoch in range(50):
            seed = seed_for_call("job", str(epoch), epoch)
            assert 1 <= seed < 2**31 - 1


class TestPlacementKind:
    """A book is classified by wall clock. boot= is not an input."""

    def test_a_restore_is_inside_the_book_budget(self):
        assert placement_kind(30) == "restore"
        assert placement_kind(90) == "restore"
        assert placement_kind(RESTORE_WALL_S) == "restore"

    def test_a_compile_is_not_a_book_wait(self):
        assert placement_kind(COMPILE_WALL_S) == "compile"
        assert placement_kind(8 * 60) == "compile"
        assert placement_kind(16 * 60) == "compile"
        # The gap between "restore" and "compile" is not a success for coverage.
        assert placement_kind(RESTORE_WALL_S + 1) == "slow"
        assert placement_kind(COMPILE_WALL_S - 1) == "slow"

    def test_the_book_budget_is_under_a_compile(self):
        assert RESTORE_WALL_S < COMPILE_WALL_S
        assert COMPILE_WALL_S < 8 * 60


class TestContainerLimits:
    def test_defaults_are_production_safe(self):
        limits = container_limits({})
        # Production stays at one container until staging signs off.
        assert limits["max_containers"] == 1
        assert limits["min_containers"] == 0
        assert limits["lanes"] == 4

    def test_reads_the_staging_target(self):
        limits = container_limits({"S2C_MAX_CONTAINERS": "4"})
        assert limits["max_containers"] == 4

    def test_clamps_nonsense(self):
        assert container_limits({"S2C_MAX_CONTAINERS": "500"})["max_containers"] == 8
        assert container_limits({"S2C_MAX_CONTAINERS": "0"})["max_containers"] == 1
        assert container_limits({"S2C_MAX_CONTAINERS": "abc"})["max_containers"] == 1
        assert container_limits({"S2C_LANES": "-4"})["lanes"] == 4


class TestHistoryAnchor:
    """Book `12534aaa` drifted inside every section and reset at each boundary.

    Speaker similarity to the reference fell 0.93 -> 0.70 over 10-12 units, F0
    fell 15-20 Hz, and the p5-p95 pitch range halved, then it snapped back at the
    next row where history starts empty. A per-row pattern can only come from
    the per-row history chain, so the chain is what has to stop walking.
    """

    def test_every_unit_is_anchored_to_the_rows_first_take(self):
        # The first take was generated from the reference alone, so it is the
        # cleanest sample of the speaker this row ever produced. Conditioning
        # unit 12 on unit 11 is what let the timbre walk; conditioning it on
        # unit 0 is one hop from the reference instead of eleven.
        history = [(f"unit {i}", i) for i in range(12)]
        anchored = history_anchor(history)
        assert anchored == [("unit 0", 0)]

    def test_the_anchor_does_not_move_as_the_row_grows(self):
        # The whole point: the prompt for the last unit must be the same turn
        # as for the second unit, so drift cannot accumulate.
        history = [(f"unit {i}", i) for i in range(20)]
        assert history_anchor(history) == history_anchor(history[:2])

    def test_an_empty_history_gives_no_turn(self):
        # Unit 0 conditions on the reference only, exactly as before.
        assert history_anchor([]) == []

    def test_rollback_restores_the_upstream_last_turn_behaviour(self):
        history = [("a", 1), ("b", 2)]
        assert history_anchor(history, anchor_first=False) == history

    def test_history_stays_one_turn(self):
        # The prompt shape is unchanged (reference + one turn + new text); only
        # *which* turn is used. Growing it would slow every prefill.
        import s2_batch

        assert s2_batch.HISTORY_TURNS == 1
        history = [(f"unit {i}", i) for i in range(12)]
        assert len(history_anchor(history)) == 1


class TestInterPhrasePause:
    """The reference median gap was 0.42 s; the renders had 0.14-0.25 s.

    The syllable rate matched the reference, so "reads too fast" was missing
    silence, not excessive speed.
    """

    def test_split_gap_moves_toward_the_reference_median(self):
        assert 0.35 <= inserted_pause_s("split") <= 0.45
        assert SPLIT_PAUSE_S > 0.25

    def test_paragraph_gap_stays_bigger_than_a_sentence_gap(self):
        assert inserted_pause_s("para") > inserted_pause_s("split")

    def test_a_paragraph_gap_does_not_stall_a_book(self):
        # A 19-minute book has ~150 paragraph breaks; 2 s each would be five
        # minutes of added silence, which is why there is a hard ceiling.
        assert inserted_pause_s("para") <= PAUSE_MAX_S

    def test_an_unknown_pause_kind_is_conservative(self):
        # A unit with no marker gets the sentence gap, never the paragraph one.
        assert inserted_pause_s("") == SPLIT_PAUSE_S
        assert inserted_pause_s(None) == SPLIT_PAUSE_S

    def test_defaults_add_pauses_without_lengthening_the_read(self):
        # The real numbers for `12534aaa`: 16,990 chars in 1,040 s of speech is
        # 16.3 chars per spoken second. At the new 200-char unit width that is
        # a gap every ~12 s, so a 0.40 s split gap adds ~3% to the book — a
        # calmer read, not a slower one. At the old 400-char width it was ~1.5%,
        # which is why the unit width had to move as well as the gap.
        speech_s = UNIT_TARGET_CHARS / 16.3
        overhead = inserted_pause_s("split") / speech_s
        assert 0.02 <= overhead <= 0.05
        # A 19-minute book grows by well under a minute.
        book_s = 1040
        added = (book_s / speech_s) * inserted_pause_s("split")
        assert added < 60


class TestUnitWidthCreatesPhrasePauses:
    """`UNIT_MAX_CHARS` is what decides whether a phrase pause exists at all.

    The renders had 6-17% silence against the reference's 35%, and the gap
    constants alone could not have fixed that: on a book at 400-char units there
    are only ~42 unit boundaries, so 0.25 -> 0.40 s adds ~17 s to a 19-minute
    read. The pauses were missing because a 355-char prose paragraph was sent as
    **one** unit under the old 600-char limit, so no split gap was ever emitted
    inside it.
    """

    def _units(self, paragraph: str, count: int = 40):
        import s2_batch

        return s2_batch.make_units([paragraph] * count)

    def _book_paragraph(self) -> str:
        # ~355 chars, the measured shape: 3,900 chars / 11 units in `12534aaa`.
        sentence = (
            "The question of how a republic decays has occupied historians for "
            "a very long time and the answer has never been simple. "
        )
        return (sentence * 4)[:355].rstrip()

    def test_a_book_length_paragraph_now_splits_into_phrase_units(self):
        units = self._units(self._book_paragraph())
        assert len(units) > 40
        splits = [u for u in units if u["pause"] == "split"]
        assert len(splits) > 0

    def test_those_splits_carry_the_longer_gap(self):
        units = self._units(self._book_paragraph())
        splits = sum(1 for u in units if u["pause"] == "split")
        # Every split boundary is one inserted phrase pause.
        assert splits * inserted_pause_s("split") > 1.0

    def test_a_short_paragraph_is_left_alone(self):
        # Under UNIT_MAX_CHARS a paragraph is kept whole and merged with its
        # neighbours toward the target, so it never gains a split gap. Changing
        # that would add breaks where a narrator would not take one.
        units = self._units("A short paragraph that clearly fits on one line.")
        assert all(u["pause"] == "para" for u in units)
        assert all(u["text"].count("\n") >= 0 for u in units)
        # Merged, not fragmented: every unit is at least the paragraph itself.
        assert all(len(u["text"]) >= 58 for u in units)

    def test_the_unit_width_fits_inside_one_generation_window(self):
        # 300 chars is ~18 s of speech; a unit is capped at ~47 s of frames.
        import s2_batch

        assert s2_batch.UNIT_MAX_CHARS < s2_batch.UNIT_TARGET_CHARS * 2
        assert s2_batch.UNIT_MAX_CHARS <= 350
