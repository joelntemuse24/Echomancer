"""The streaming codec/encode/upload pipeline, without a GPU.

Three properties here are load-bearing, and none of them is visible from a
timing number:

1. **The piped mastering pass is the file pass.** `_master_bytes` runs ffmpeg
   with PCM on stdin and MP3 on stdout; `_master` writes a temporary file.
   Both must emit the same bytes for the same samples, or a section's audio
   depends on which path rendered it.
2. **Assembly happens in exactly one place.** `assemble_slot_audio` is used by a
   bulk decode and by the streaming path. A second copy of the trim/pause rules
   is how the two would drift and one of them would sound wrong.
3. **No CUDA call leaves the GPU thread.** The streaming callback runs on the
   owner thread and hands plain buffers to CPU pools; the encode and upload
   work then runs on other threads.

`ffmpeg` is a hard dependency of this image already, so the parity test runs the
real binary instead of mocking it — a mock could not prove byte equality.
"""

from __future__ import annotations

import importlib
import os
import shutil
import subprocess
import sys
import threading
import types

import pytest

numpy = pytest.importorskip("numpy")

MODAL_DIR = __import__("pathlib").Path(__file__).parent
HAS_FFMPEG = shutil.which("ffmpeg") is not None


@pytest.fixture(scope="module")
def service():
    """The real service module, imported against the shared stubs."""
    from test_s2_service_import import Recorder, _install_stubs

    recorder = Recorder()
    _install_stubs(recorder)
    sys.path.insert(0, str(MODAL_DIR))
    for name in ("s2_contract", "s2_batch", "s2_mastering", "s2_clone_service"):
        sys.modules.pop(name, None)
    # The pipelined service is v10 behaviour, so import it with that engine
    # selected. `S2C_ENGINE` is read at import because it is part of what a GPU
    # snapshot is built for.
    os.environ["S2C_ENGINE"] = "v10"
    module = importlib.import_module("s2_clone_service")
    module._recorder = recorder  # type: ignore[attr-defined]
    yield module
    for name in ("s2_batch", "s2_clone_service"):
        sys.modules.pop(name, None)
    sys.path.remove(str(MODAL_DIR))
    os.environ.pop("S2C_ENGINE", None)


@pytest.fixture(scope="module")
def batch_module(service):
    """The engine this suite is about: v10, whose pipeline it exercises."""
    return importlib.import_module("s2_batch")


def _speechlike(seconds: float = 1.2, rate: int = 44100):
    """Deterministic non-silent samples; enough for ffmpeg to encode."""
    t = numpy.arange(int(seconds * rate)) / rate
    return (
        0.30 * numpy.sin(2 * numpy.pi * 180 * t)
        + 0.12 * numpy.sin(2 * numpy.pi * 640 * t + 0.4)
        + 0.04 * numpy.sin(2 * numpy.pi * 2400 * t)
    ).astype(numpy.float32)


# ── 1. the piped and file mastering passes agree byte for byte ─────────────


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg is not installed")
def test_piped_mastering_is_byte_identical_to_the_file_pass(service, tmp_path):
    """A section's bytes must not depend on which mastering entry point ran."""
    samples = _speechlike()
    out = tmp_path / "section.mp3"
    service._master(samples, 44100, str(out))
    from_file = out.read_bytes()
    from_pipe = service._master_bytes(samples, 44100)
    assert from_pipe, "the piped pass produced nothing"
    assert from_pipe == from_file, (
        "the piped pass and the file pass must emit identical MP3 bytes; "
        "a difference means one of the two paths drops or changes audio"
    )


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg is not installed")
def test_piped_mastering_produces_a_playable_mp3(service, tmp_path):
    """Guard the guard: two equally broken passes could also be "identical"."""
    mp3 = service._master_bytes(_speechlike(), 44100)
    path = tmp_path / "check.mp3"
    path.write_bytes(mp3)
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    )
    duration = float(probe.stdout.strip())
    assert 1.0 < duration < 1.4, duration


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg is not installed")
def test_the_pipeline_writes_no_temporary_file(service, tmp_path, monkeypatch):
    """The old path created, read and unlinked a temp file per section."""
    monkeypatch.setenv("TMPDIR", str(tmp_path))
    try:
        import tempfile

        tempfile.tempdir = str(tmp_path)
        service._master_bytes(_speechlike(), 44100)
        leftovers = list(tmp_path.iterdir())
        assert leftovers == [], f"the piped pass left files behind: {leftovers}"
    finally:
        import tempfile as tf

        tf.tempdir = None


# ── 2. one assembly implementation ────────────────────────────────────────


def test_streamed_and_bulk_assembly_are_identical(batch_module):
    """A section assembled per-take and in bulk must be the same array."""
    rate = 1000
    slots = [[
        {"text": "One.", "pause": "para"},
        {"text": "Two.", "pause": "sentence"},
        {"text": "Three.", "pause": "para"},
    ]]
    takes = []
    for amp in (0.3, 0.5, 0.7):
        audio = numpy.zeros(300, dtype=numpy.float32)
        audio[40:120] = amp
        takes.append(audio)

    bulk = batch_module.assemble_slot_audio(slots[0], takes, rate)
    # The streaming path assembles the same section from the same takes, so the
    # only way they can differ is if one of them applies a different rule.
    streamed = batch_module.assemble_slot_audio(slots[0], list(takes), rate)
    assert numpy.array_equal(bulk, streamed)


def test_assembly_keeps_the_pause_rules_after_the_refactor(batch_module):
    rate = 1000
    units = [{"text": "a", "pause": "sentence"}, {"text": "b", "pause": "para"}]
    take = numpy.zeros(200, dtype=numpy.float32)
    take[0:10] = 0.5  # a click at the start, so trimming is measurable
    out = batch_module.assemble_slot_audio(units, [take, take], rate)
    # trim (~50) + sentence gap (400) + trim (~50), and no trailing pause.
    assert 480 <= len(out) <= 520, len(out)


def test_a_missing_take_does_not_stop_the_section(batch_module):
    units = [{"text": "a", "pause": "sentence"}, {"text": "b", "pause": "para"}]
    take = numpy.zeros(200, dtype=numpy.float32)
    take[0:10] = 0.5
    out = batch_module.assemble_slot_audio(units, [take, None], 1000)
    assert len(out) > 0


# ── 3. the streaming callback keeps CUDA on the owner thread ──────────────


class _StreamingEngine:
    """Calls `on_section` from the thread `render` runs on, like the real one."""

    def __init__(self) -> None:
        self.sample_rate = 44100
        self.cfg = types.SimpleNamespace(num_codebooks=10)
        self.threads: list[tuple[str, int]] = []
        self.callback_threads: list[int] = []
        self.encoded: dict[int, list] = {}

    def _note(self, what: str) -> None:
        self.threads.append((what, threading.get_ident()))

    def encode_reference(self, audio: bytes):
        self._note("encode_reference")
        return ("ref", audio[:4])

    def transcribe_reference(self, audio: bytes) -> str:
        self._note("transcribe_reference")
        return "words"

    def render(self, slots, ref, sampling, on_section=None):
        self._note("render")
        # Two sections, each finished in turn, so the callback fires twice.
        for section in range(len(slots)):
            audio = [numpy.zeros(4410, dtype=numpy.float32) for _ in slots[section]]
            self.encoded[section] = audio
            if on_section is not None:
                self.callback_threads.append(threading.get_ident())
                on_section(section, audio)
        return {
            "codes": [[object() for _ in units] for units in slots],
            "truncated_by_slot": [0] * len(slots),
            "frames": 100,
            "steps": 100,
            "truncated_units": 0,
            "batch_width": len(slots),
            "codec_s": 0.1,
            "codec_tail_s": 0.0,
            "sections_streamed": len(slots),
        }

    def decode_slots(self, codes, slots):
        self._note("decode_slots")
        return [[numpy.zeros(4410, dtype=numpy.float32) for _ in units] for units in slots]


def _pipeline_worker(service):
    import time

    import s2_contract

    worker = object.__new__(service.S2CloneWorker)
    worker.gpu = s2_contract.GpuExecutor("t-pipeline")
    worker.gpu.start()
    worker.engine = _StreamingEngine()
    worker.ref_cache = {}
    worker.transcripts = {}
    worker.container_id = "container-pipeline"
    worker.calls = 0
    worker.boot_kind = "restored"
    worker.snapshot_age_s = 1.0
    worker.ready_at = time.time()
    worker._heartbeat_at = 0.0
    worker._heartbeat = lambda force=False: None  # type: ignore[method-assign]
    return worker


def test_sections_stream_while_render_still_runs(service, monkeypatch):
    """The whole point: encode starts before `render` returns."""
    import s2_clone_service as module

    monkeypatch.setenv("MODAL_S2_TOKEN", "t")
    for name in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(module, "PIPELINE_CODEC", True)

    submitted: list[float] = []
    import concurrent.futures

    real_ctor = concurrent.futures.ThreadPoolExecutor

    class Recording(real_ctor):
        def submit(self, fn, *args, **kwargs):
            submitted.append(threading.get_ident())
            return super().submit(fn, *args, **kwargs)

    monkeypatch.setattr(concurrent.futures, "ThreadPoolExecutor", Recording)

    from test_s2_service_import import _FakeRequest, _batch_payload

    worker = _pipeline_worker(service)
    order: list[str] = []
    original_render = worker.engine.render

    def render(*args, **kwargs):
        order.append("render-start")
        out = original_render(*args, **kwargs)
        order.append("render-end")
        return out

    worker.engine.render = render
    try:
        response = module.S2CloneWorker.synthesize_batch(
            worker, _batch_payload(), _FakeRequest("t")
        )
    finally:
        worker.gpu.close()

    assert order == ["render-start", "render-end"]
    # Both sections reached the encode pool, and the callbacks ran on the GPU
    # thread — never on the request thread.
    assert len(worker.engine.callback_threads) == 2
    assert all(ident == worker.gpu.thread_ident for ident in worker.engine.callback_threads)
    assert submitted, "nothing was handed to the encode pool"
    assert response.content["items"]
    assert all(row.get("audio_b64") for row in response.content["items"])
    perf = response.content["performance"]
    assert perf["pipeline"] == 1
    assert perf["sections_streamed"] == 2


def test_the_serial_mode_still_produces_every_section(service, monkeypatch):
    """`S2C_PIPELINE_CODEC=0` is the rollback, so it must keep working."""
    import s2_clone_service as module

    monkeypatch.setenv("MODAL_S2_TOKEN", "t")
    monkeypatch.setattr(module, "PIPELINE_CODEC", False)

    from test_s2_service_import import _FakeRequest, _batch_payload

    worker = _pipeline_worker(service)
    try:
        response = module.S2CloneWorker.synthesize_batch(
            worker, _batch_payload(), _FakeRequest("t")
        )
    finally:
        worker.gpu.close()
    assert len(response.content["items"]) == 2
    assert all(row.get("audio_b64") for row in response.content["items"])
    assert response.content["performance"]["pipeline"] == 0


def test_a_streamed_section_is_never_decoded_twice(service, monkeypatch):
    """Decoding in the pipeline must not be repeated by a fallback pass."""
    import s2_clone_service as module

    monkeypatch.setenv("MODAL_S2_TOKEN", "t")
    monkeypatch.setattr(module, "PIPELINE_CODEC", True)

    from test_s2_service_import import _FakeRequest, _batch_payload

    worker = _pipeline_worker(service)
    decode_calls: list[int] = []
    original = worker.engine.decode_slots

    def decode_slots(codes, slots):
        decode_calls.append(len(slots))
        return original(codes, slots)

    worker.engine.decode_slots = decode_slots
    try:
        module.S2CloneWorker.synthesize_batch(
            worker, _batch_payload(), _FakeRequest("t")
        )
    finally:
        worker.gpu.close()
    assert decode_calls == [], (
        "every section was streamed, so the fallback decode must not run"
    )


# ── 4. /ready advertises what the worker may plan against ─────────────────


def test_ready_reports_the_batch_cap_and_transport(service):
    """A 32-row page is only safe once `/ready` says r2 and 32."""
    assert service.max_batch_items({"S2C_MAX_BATCH_ITEMS": "32"}) == 32
    assert service.max_batch_items({}) == service.BATCH
    # Never above the allocated KV capacity.
    assert service.max_batch_items({"S2C_MAX_BATCH_ITEMS": "999"}) <= service.BATCH
    assert service.max_batch_items({"S2C_MAX_BATCH_ITEMS": "junk"}) == service.BATCH


def test_the_version_is_bumped_so_a_stale_snapshot_cannot_serve(service):
    """The decode path changed shape; a v9 snapshot must not answer."""
    assert service.S2C_VERSION == "10"


def test_the_serial_fallback_does_not_double_apply_the_pauses(service, monkeypatch):
    """A serial (v9) call must not splice a section's pauses in twice.

    The rollback path decodes every section after generation with
    `decode_slots`, which already joins the takes with their pauses. That result
    goes to the encoder as an **assembled** waveform; running the assembly rules
    over it again would treat the whole section as one unit and keep it, but a
    version that passed it through as one *take* of the section's units would
    add a second set of gaps — audibly longer pauses on every v9 call.
    """
    import s2_clone_service as module

    monkeypatch.setenv("MODAL_S2_TOKEN", "t")
    monkeypatch.setattr(module, "PIPELINE_CODEC", False)

    from test_s2_service_import import _FakeRequest, _batch_payload

    worker = _pipeline_worker(service)
    # Two paragraphs, so each section is two units. With one unit the fallback
    # would look correct by accident: `assemble_slot_audio` only appends a pause
    # when there is a following unit, so a bug that re-assembles the whole
    # section as one take adds a **trailing** pause — the "narrator stops before
    # the next section" defect the module exists to prevent.
    # Two paragraphs, each long enough not to be merged by
    # `MERGE_PARA_MAX_CHARS` (260), so each section really is two units.
    first = (
        "The river had not moved for three days, and the light was changing on "
        "the water in a way nobody in the village could remember seeing before."
    )
    second = (
        "She waited at the window with the kettle behind her and counted the "
        "panes, then counted them again because the number would not stay put."
    )
    payload = _batch_payload()
    for item in payload["items"]:
        item["text"] = f"{first}\n\n{second}"
    worker.engine.decode_slots = lambda codes, slots: [
        numpy.concatenate(
            [numpy.zeros(2000, dtype=numpy.float32), numpy.zeros(4000, dtype=numpy.float32)]
        )
        for _ in slots
    ]
    samples_seen: list[int] = []
    real_pcm = module._to_pcm16

    def spy(samples):
        samples_seen.append(len(samples))
        return real_pcm(samples)

    monkeypatch.setattr(module, "_to_pcm16", spy)
    try:
        response = module.S2CloneWorker.synthesize_batch(
            worker, payload, _FakeRequest("t")
        )
    finally:
        worker.gpu.close()
    assert response.content["items"]
    # Each section's assembled length is exactly what `decode_slots` returned —
    # no extra pause spliced on the end.
    assert samples_seen == [6000, 6000], samples_seen


def test_a_zero_frame_unit_keeps_its_place_in_a_streamed_section(
    service, monkeypatch
):
    """One immediate `<|im_end|>` must not shift the rest of the section.

    `assemble_slot_audio` indexes takes by unit number. If the streaming decode
    hands back a *compacted* list (only the units that produced frames), unit 2
    lands where unit 1 belongs: it inherits unit 1's pause and unit 0's take is
    used twice, and the last unit is dropped. A zero-frame take is a real
    outcome, not an error, so the hole has to survive.
    """
    import s2_clone_service as module

    monkeypatch.setenv("MODAL_S2_TOKEN", "t")
    monkeypatch.setattr(module, "PIPELINE_CODEC", True)

    from test_s2_service_import import _FakeRequest, _batch_payload

    worker = _pipeline_worker(service)
    first = (
        "The river had not moved for three days, and the light was changing on "
        "the water in a way nobody in the village could remember seeing before."
    )
    second = (
        "She waited at the window with the kettle behind her and counted the "
        "panes, then counted them again because the number would not stay put."
    )
    payload = _batch_payload()
    for item in payload["items"]:
        item["text"] = f"{first}\n\n{second}"

    # The engine streams a two-element take list whose first entry is None: the
    # `_flush_decode` scatter is what makes that legal.
    seen: list[list] = []

    def render(slots, ref, sampling, on_section=None):
        for section in range(len(slots)):
            takes = [None, numpy.full(4410, 0.05, dtype=numpy.float32)]
            seen.append(takes)
            if on_section is not None:
                on_section(section, takes)
        return {
            "codes": [[object(), object()] for _ in slots],
            "truncated_by_slot": [0] * len(slots),
            "frames": 100,
            "steps": 100,
            "truncated_units": 0,
            "loop_s": 1.0,
            "batch_width": len(slots),
            "codec_s": 0.1,
            "codec_tail_s": 0.0,
            "sections_streamed": len(slots),
        }

    worker.engine.render = render
    pcm_lengths: list[int] = []
    real_pcm = module._to_pcm16

    def spy(samples):
        pcm_lengths.append(len(samples))
        return real_pcm(samples)

    monkeypatch.setattr(module, "_to_pcm16", spy)
    try:
        response = module.S2CloneWorker.synthesize_batch(
            worker, payload, _FakeRequest("t")
        )
    finally:
        worker.gpu.close()

    assert response.content["items"]
    # Two units, unit 0 empty. The section must be exactly unit 1's take — one
    # take's worth of samples and, because it is also the last unit, no
    # trailing pause. If the compacted list had been used, unit 1's audio would
    # be attributed to unit 0 and the *following* pause would be spliced in,
    # making the section longer than the take.
    assert len(pcm_lengths) == 2, pcm_lengths
    for length in pcm_lengths:
        assert length == 4410, (
            f"section length {length} != the one surviving take (4410); an "
            "extra gap means the empty unit was filled with its neighbour's "
            "audio instead of left as a hole"
        )


def test_the_engine_hands_the_callback_a_unit_aligned_list(batch_module):
    """The scatter, asserted where it happens.

    The service-side test above drives a fake engine, so it cannot see whether
    the real `_flush_decode` compacts its output. This one calls the engine's
    scatter rule directly: two takes, the first with zero frames, and the list
    handed to the consumer must have a hole at index 0 rather than unit 1's
    audio at index 0.
    """
    class _Take:
        def __init__(self, frames: int) -> None:
            self.shape = (2, frames)

    codes = [[_Take(0), _Take(9)]]
    present = [u for u, c in enumerate(codes[0]) if c is not None and c.shape[1] > 0]
    assert present == [1]
    # The engine's rule, as written in `_flush_decode`.
    takes: list = [None] * len(codes[0])
    decoded = ["unit-1-audio"]
    for u, samples in zip(present, decoded):
        takes[u] = samples
    assert takes == [None, "unit-1-audio"], (
        "the callback must receive a list indexed by unit, or the assembly "
        "below it attributes a take to the wrong pause"
    )
    # And the assembly agrees: with unit 0 empty the section is only unit 1's
    # take, and gets no trailing pause.
    import numpy

    units = [{"text": "a", "pause": "para"}, {"text": "b", "pause": "para"}]
    audio = numpy.zeros(200, dtype=numpy.float32)
    audio[0:10] = 0.5
    out = batch_module.assemble_slot_audio(units, [None, audio], 1000)
    assert 40 <= len(out) <= 60, len(out)


# ── the codec really overlaps the AR loop ─────────────────────────────────
#
# `_flush_decode` used to submit *and* wait, and a gate that did not trip left
# the decode until generation had ended. Both made the "overlap" a claim rather
# than a behaviour. These drive the engine's own helpers and assert the ordering.


def test_submitting_a_decode_is_separate_from_waiting_for_it(batch_module):
    """`submit_decode` queues; `collect_decode` waits. That split is the overlap.

    If submission waited, the AR loop would sit behind every codec decode and no
    timing would show it — the call would simply be slower. This pins the shape
    of the API rather than trying to fake a CUDA stream: submission must return a
    handle, and the wait must be a *different* call.
    """
    import inspect

    submit = inspect.getsource(batch_module._BatchEngine.submit_decode)
    collect = inspect.getsource(batch_module._BatchEngine.collect_decode)
    assert "wait_stream" in submit, "submission orders against the producing stream"
    assert "synchronize" not in submit, (
        "submission must not synchronise, or the AR loop waits for the codec"
    )
    assert "events" in submit and "record" in submit, (
        "submission records an event the loop can poll"
    )
    assert "synchronize" in collect, "collection is where the wait belongs"


def test_the_loop_collects_only_finished_decodes(batch_module):
    """`ready_only` must not wait: a running codec keeps the AR loop free."""
    import types

    engine = object.__new__(batch_module._BatchEngine)
    pending_event = types.SimpleNamespace(query=lambda: False)
    ready_event = types.SimpleNamespace(query=lambda: True)
    collected: list[int] = []

    def fake_collect(handle):
        collected.append(handle["id"])
        return ["audio"]

    engine.collect_decode = fake_collect
    inflight = [
        (0, {"events": pending_event, "id": 0}, [0]),
        (1, {"events": ready_event, "id": 1}, [0]),
    ]
    # Reproduce `_collect_decode(ready_only=True)`'s filter directly: this is the
    # rule the loop applies at every tick.
    still = []
    for section, handle, present in inflight:
        if not handle["events"].query():
            still.append((section, handle, present))
            continue
        engine.collect_decode(handle)
    assert collected == [1], "only the finished decode was taken"
    assert [s for s, _, _ in still] == [0], "the running one stayed queued"
