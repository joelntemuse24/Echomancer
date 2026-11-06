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
    CLAUSE_PAUSE_S,
    SPLIT_PAUSE_S,
    UNIT_MAX_CHARS,
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
    split_long_text,
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
        # Read from source: `s2_batch` imports `modal`, which is not installable
        # in a laptop test run (the repo's `modal/` dir shadows the package).
        import pathlib
        import re

        source = pathlib.Path(__file__).with_name("s2_batch.py").read_text()
        match = re.search(r"^HISTORY_TURNS = (\d+)$", source, re.MULTILINE)
        assert match, "HISTORY_TURNS not found in s2_batch.py"
        assert int(match.group(1)) == 1
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
        # An unrecognised kind gets the short clause gap, never a long one: a
        # pause that is too short is far safer than one that reads as a stop.
        assert inserted_pause_s("nonsense") == CLAUSE_PAUSE_S
        assert inserted_pause_s(None) == CLAUSE_PAUSE_S
        assert CLAUSE_PAUSE_S < SPLIT_PAUSE_S

    def test_the_old_split_label_still_means_a_sentence_gap(self):
        # A stored job or older caller can still say "split"; it must not fall
        # through to the shorter clause gap.
        assert inserted_pause_s("split") == SPLIT_PAUSE_S

    def test_defaults_add_pauses_without_lengthening_the_read(self):
        # The real numbers for `12534aaa`: 16,990 chars in 1,040 s of speech is
        # 16.3 chars per spoken second. A unit is now ~37 s of speech, so a
        # 0.40 s gap adds ~1% per boundary — and there are far fewer boundaries
        # than under #244/#245, so the book grows by well under a minute.
        speech_s = UNIT_MAX_CHARS / 16.3
        overhead = inserted_pause_s("sentence") / speech_s
        assert 0.01 <= overhead <= 0.04
        book_s = 1040
        added = (book_s / speech_s) * inserted_pause_s("sentence")
        assert added < 60


#: The sentence that made `job 1f0137a1` section 2 answer HTTP 422 twice and be
#: dropped from the book: 318 chars, em dash with **no space after it**.
VDH_FAILING_SENTENCE = (
    "But they do use brilliantly the landscape of contemporary eighteenth-century "
    "agriculture to demonstrate how the natural bounty of America and the "
    "availability of vast expanses of farmland molded the European religious and "
    "political heritage into something far more dynamic\u2014something never before "
    "seen or even imagined."
)


def _normalise(text: str) -> str:
    """Compare content, not spacing.

    A split may add a space after a no-space dash (`dynamic—something` becomes
    `dynamic— something`), which is the whitespace normalisation the docstring
    promises. What must never change is the characters themselves.
    """
    return "".join(text.split())


class TestSplitLongTextNeverFails:
    """One unsplittable unit used to cost a whole section, so the splitter is total.

    `_section_units` in the container raises when any unit exceeds
    `UNIT_MAX_CHARS`, and that `ValueError` becomes a 422 that drops the section.
    The old `_CLAUSE_END` required whitespace after the dash, so a 318-char
    sentence with `dynamic—something` could not be bounded at all.
    """

    def test_the_actual_failing_sentence_is_a_legal_unit(self):
        assert len(VDH_FAILING_SENTENCE) == 318
        units = split_long_text(VDH_FAILING_SENTENCE)
        assert units, "the splitter returned nothing"
        assert max(len(text) for text, _ in units) <= UNIT_MAX_CHARS
        # And it fits whole, so it never reaches the clause path at all.
        assert len(units) == 1
        assert _normalise(units[0][0]) == _normalise(VDH_FAILING_SENTENCE)

    def test_no_text_is_lost(self):
        units = split_long_text(VDH_FAILING_SENTENCE)
        assert _normalise(" ".join(text for text, _ in units)) == _normalise(
            VDH_FAILING_SENTENCE
        )

    def test_an_em_dash_without_a_space_can_still_bound_a_piece(self):
        # The exact character pattern, on text forced small enough to split.
        text = "alpha beta gamma\u2014delta epsilon zeta eta theta iota kappa"
        units = split_long_text(text, hard_max=24)
        assert len(units) > 1
        assert max(len(t) for t, _ in units) <= 24
        assert _normalise(" ".join(t for t, _ in units)) == _normalise(text)

    def test_every_unicode_dash_variant_splits(self):
        dash = "\u2014\u2013\u2015\u2012"
        for mark in dash:
            text = f"alpha beta{mark}gamma delta epsilon zeta eta theta"
            units = split_long_text(text, hard_max=22)
            assert max(len(t) for t, _ in units) <= 22, repr(mark)
            assert _normalise(" ".join(t for t, _ in units)) == _normalise(text)

    def test_no_space_after_comma_or_colon_still_splits(self):
        for mark in (",", ":", ";"):
            text = "alpha beta{0}gamma delta epsilon zeta eta theta".format(mark)
            units = split_long_text(text, hard_max=22)
            assert max(len(t) for t, _ in units) <= 22, mark

    def test_a_single_enormous_token_is_sliced_not_rejected(self):
        # A URL or a glued OCR run has no punctuation and no spaces. It must
        # still produce legal units rather than a 422 that drops the section.
        token = "a" * 1000
        units = split_long_text(token)
        assert max(len(t) for t, _ in units) <= UNIT_MAX_CHARS
        assert "".join(t for t, _ in units) == token

    def test_a_long_token_inside_prose_does_not_lose_the_prose(self):
        text = "alpha beta " + "z" * 900 + " gamma delta"
        units = split_long_text(text)
        assert max(len(t) for t, _ in units) <= UNIT_MAX_CHARS
        assert _normalise(" ".join(t for t, _ in units)) == _normalise(text)

    def test_a_paragraph_of_only_punctuation_does_not_loop(self):
        # Degenerate input must terminate, not spin in the hard slice.
        text = "\u2014" * 500
        units = split_long_text(text)
        assert units
        assert max(len(t) for t, _ in units) <= UNIT_MAX_CHARS

    def test_an_empty_paragraph_yields_no_units(self):
        assert split_long_text("") == []
        assert split_long_text("   \n  ") == []


class TestUnitCeilingFitsTheModel:
    """`UNIT_MAX_CHARS` is decided by the decode loop's frame cap, not taste.

    A unit is one generation. `MAX_NEW_FRAMES` bounds it, and a take that hits
    the cap is `truncated` — the worker treats that as an incomplete section and
    the section fails if it happens twice. So the ceiling has to fit the frame
    budget at the slowest pace this pipeline produces.

    The constant is read out of `s2_batch.py` rather than imported, because
    `s2_batch` imports `modal` (not installable in a laptop test run: this
    directory shadows the package). This is the same technique the history test
    uses for `HISTORY_TURNS`.
    """

    #: Codec frames per second: `44100 / frame_length` (2048) ≈ 21.53.
    FRAMES_PER_SECOND = 44100 / 2048
    #: Characters per audio second at the slowest production narration.
    #: Measured 16.3–17.3 on `12534aaa` / `1f0137a1`; 13 gives ~20 % headroom.
    SLOWEST_CHARS_PER_SECOND = 13.0

    def _batch_constant(self, name: str) -> int:
        import pathlib
        import re

        source = pathlib.Path(__file__).with_name("s2_batch.py").read_text()
        match = re.search(rf"^{name} = (\w+)", source, re.MULTILINE)
        assert match, f"{name} not found in s2_batch.py"
        value = match.group(1)
        if value.isdigit():
            return int(value)
        # Something like `int(os.environ.get("S2B_MAX_SEQ_LEN", "4096"))`.
        inner = re.search(r'"(\d+)"', value)
        assert inner, f"{name} is not a literal or an int(env) default: {value}"
        return int(inner.group(1))

    def test_the_ceiling_speaks_inside_the_frame_cap(self):
        max_new_frames = self._batch_constant("MAX_NEW_FRAMES")
        seconds = max_new_frames / self.FRAMES_PER_SECOND
        need = UNIT_MAX_CHARS / self.SLOWEST_CHARS_PER_SECOND
        assert need < seconds, (
            f"UNIT_MAX_CHARS={UNIT_MAX_CHARS} needs {need:.1f}s at "
            f"{self.SLOWEST_CHARS_PER_SECOND} chars/s but MAX_NEW_FRAMES="
            f"{max_new_frames} only covers {seconds:.1f}s; a take that hits the "
            f"cap is truncated and the section is retried"
        )
        # And there is real headroom, not a hair's breadth: a snapshot rebuild
        # is the cost of raising the cap, so this must not need one.
        assert seconds - need >= 2.0, (seconds, need)

    def test_the_ceiling_is_the_longest_unit_that_fits(self):
        # If a much longer unit would also fit, the ceiling is leaving quality
        # (fewer splices) on the table.
        max_new_frames = self._batch_constant("MAX_NEW_FRAMES")
        seconds = max_new_frames / self.FRAMES_PER_SECOND
        longest_safe = seconds * self.SLOWEST_CHARS_PER_SECOND
        assert UNIT_MAX_CHARS >= longest_safe * 0.6, (UNIT_MAX_CHARS, longest_safe)


class TestSplitLongTextPacing:
    """A unit boundary is a splice between two separately generated takes.

    Joel, after `1f0137a1`: *"orally it just sounds terrible, like it stops and
    starts every time"*. The measured cause was the boundary **count**, not the
    gap width: at target 200 a paragraph of ~150-char sentences became one unit
    per sentence, each with its own inserted pause on top of the model's own.
    #245 moved 200/300 -> 300/400 and still left ~3.7 splices per audio minute.

    These tests pin the property that matters: **the count of splices a
    paragraph receives**, not the width of any one unit. A paragraph that fits
    the ceiling must receive none.
    """

    def _section(self) -> str:
        sentence = (
            "He believed that the farmland of North America was everything the "
            "old world had never permitted, and that it explained a great deal. "
        )
        return (sentence * 11).strip()

    def test_a_paragraph_under_the_ceiling_is_one_generation(self):
        # The common case for ordinary prose: one take, so the model places
        # every breath inside the paragraph and nothing is spliced.
        text = (
            "He believed that the farmland of North America was everything the "
            "old world had never permitted. It explained a great deal about the "
            "character of the people who settled it, and about the institutions "
            "they built."
        )
        assert len(text) < UNIT_MAX_CHARS
        units = split_long_text(text)
        assert len(units) == 1
        assert units[0][1] == "para"
        assert _normalise(units[0][0]) == _normalise(text)

    def test_the_default_is_materially_longer_than_the_245_values(self):
        # The point of this change: not another 0.05 s pause tweak.
        assert UNIT_MAX_CHARS >= 560
        # And it still has to be a length the container can speak; see
        # TestUnitCeilingFitsTheModel for the frame budget.
        assert UNIT_MAX_CHARS > 400

    def test_a_long_paragraph_gets_the_fewest_balanced_units(self):
        # 4,388 chars of identical 132-char sentences at a 600 ceiling: four
        # sentences is 531 and five is 664, so nine takes is the true minimum
        # (33 sentences / 4). What must not happen is a stub taking it to ten,
        # or a run of full takes followed by one 132-char unit.
        text = " ".join([self._section()] * 3)
        units = split_long_text(text)
        assert max(len(t) for t, _ in units) <= UNIT_MAX_CHARS
        lengths = sorted(len(t) for t, _ in units)
        assert len(units) == 9, lengths
        assert lengths[0] >= lengths[-1] * 0.5, lengths
        # The takes are as even as whole sentences allow: only two sizes.
        assert len({round(length / 60) for length in lengths}) <= 2

    def test_a_stub_tail_is_never_left_behind(self):
        # Sentences that divide badly: 24 takes of 63 chars at ceiling 600 want
        # 9 sentences each (573) with 5 left over. Greedy leaves that remainder
        # as a lone short take; the balanced pack redistributes it.
        sentences = [f"Sentence number {i} is here and it has some length to it. " for i in range(26)]
        text = "".join(sentences).strip()
        units = split_long_text(text)
        lengths = [len(t) for t, _ in units]
        assert max(lengths) <= UNIT_MAX_CHARS
        assert min(lengths) >= UNIT_MAX_CHARS * 0.4, lengths

    def test_packing_never_loses_text_at_any_width(self):
        text = self._section()
        for hard in (300, 400, UNIT_MAX_CHARS):
            units = split_long_text(text, hard_max=hard)
            assert _normalise(" ".join(t for t, _ in units)) == _normalise(text)

    def test_a_boundary_that_ends_a_sentence_says_so(self):
        units = split_long_text(" ".join([self._section()] * 3))
        for text, kind in units[:-1]:
            assert text.rstrip()[-1] in ".!?", (text[-40:], kind)
            assert kind == "sentence"

    def test_only_the_last_unit_of_a_paragraph_is_a_paragraph_break(self):
        units = split_long_text(" ".join([self._section()] * 3))
        assert units[-1][1] == "para"
        assert all(kind != "para" for _, kind in units[:-1])

    def test_a_forced_clause_break_is_labelled_and_shorter(self):
        # One sentence longer than the ceiling: it must split, and the pieces
        # must not claim to be sentence ends.
        one_sentence = (
            "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu "
            "nu xi omicron pi rho sigma tau upsilon phi chi psi omega, "
            "and then a second clause that keeps going for a while longer"
        )
        units = split_long_text(one_sentence, hard_max=80)
        assert len(units) > 1
        assert max(len(t) for t, _ in units) <= 80
        clause = [k for k in (kind for _, kind in units[:-1]) if k == "clause"]
        assert clause, "a mid-sentence break should be labelled clause"
        assert inserted_pause_s("clause") < inserted_pause_s("sentence")

    def test_pause_ladder_orders_sentence_above_clause_below_paragraph(self):
        assert inserted_pause_s("clause") < inserted_pause_s("sentence")
        assert inserted_pause_s("sentence") < inserted_pause_s("para")
        # The sentence gap stays near the reference's 0.42 s median.
        assert 0.35 <= inserted_pause_s("sentence") <= 0.45
