"""Reference-audio decode for the containers a person can actually upload.

The production failure this file exists for, on `job 5f09ee0e` (2026-11-06):

    with av.open(input_file, mode="r", metadata_errors="ignore") as container:
    TypeError: open() got an unexpected keyword argument 'metadata_errors'
    POST / -> 500 Internal Server Error

That traceback is `faster-whisper`'s `decode_audio`, reached from
`_BatchEngine.transcribe_reference`, after `torchaudio.load` had already gone
through the same PyAV. The PyAV pinned by fish-speech's lockfile predates the
kwarg (it was removed in PyAV 19, and every 19.x `av.open` rejects it), so a
reference that was not raw WAV killed every lane with a 500 in about 30 s. A
WAV probe passed because it never needed a decoder beyond the codec's own.

Two things are asserted here:

1. Every container the worker sends decodes, end to end, through the real
   `decode_reference_samples`. Synthetic MP3/M4A/OGG/FLAC/WebM fixtures are
   generated with the same ffmpeg the image has, so nothing is committed as a
   binary blob that could rot.
2. Nothing on the reference path calls into PyAV or `torchaudio`. That is the
   structural half of the regression: a future edit that reintroduces
   `torchaudio.load` or `av.open` fails here, not on a customer's book.

Run with:  python3 -m pytest modal -q
"""

from __future__ import annotations

import ast
import inspect
import math
import shutil
import struct
import subprocess
import sys
import textwrap
import types
import wave

import pytest

from s2_contract import (
    REFERENCE_DECODE_RATE,
    ReferenceClipError,
    decode_reference_samples,
    decoded_reference_stats,
    reference_container,
    reference_stats,
    validate_reference_audio,
)


def _batch_module():
    """`s2_batch` with the Modal/FastAPI stubs installed, shared with the other
    suites so there is one definition of the stubbed API surface."""
    if "s2_batch" in sys.modules:
        return sys.modules["s2_batch"]
    import pathlib

    modal_dir = pathlib.Path(__file__).parent
    sys.path.insert(0, str(modal_dir))
    from test_s2_service_import import Recorder, _install_stubs

    _install_stubs(Recorder())
    try:
        return __import__("s2_batch")
    finally:
        sys.path.remove(str(modal_dir))


# ── fixtures: real encoded audio, made with the image's own ffmpeg ──────────


def _pcm16(seconds: float, rate: int = 44_100) -> bytes:
    """A voiced-sounding tone burst, as raw s16le mono samples."""
    frames = int(seconds * rate)
    out = bytearray(frames * 2)
    for i in range(frames):
        t = i / rate
        v = 0.5 * math.sin(2 * math.pi * 180 * t) + 0.25 * math.sin(2 * math.pi * 640 * t)
        struct.pack_into("<h", out, i * 2, int(v * 20000))
    return bytes(out)


def _wav(seconds: float = 3.0, rate: int = 44_100, channels: int = 1) -> bytes:
    import io

    mono = _pcm16(seconds, rate)
    if channels == 1:
        frames = mono
    else:
        # Duplicate each frame so a downmix has something to average.
        frames = b"".join(mono[i : i + 2] * channels for i in range(0, len(mono), 2))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(frames)
    return buf.getvalue()


def _ffmpeg() -> str:
    path = shutil.which("ffmpeg")
    if not path:
        pytest.skip("ffmpeg is not on PATH")
    return path


def _encode(codec: str, seconds: float = 3.0, *, silence: bool = False) -> bytes:
    """Encode a real container with ffmpeg. Skips when the encoder is absent.

    ISO-BMFF (mp4/m4a) cannot be muxed to a pipe — the muxer needs to seek —
    so those go through a temporary file. Everything else streams.
    """
    import pathlib
    import tempfile

    args = [_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y"]
    if silence:
        args += ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono"]
        payload = b""
    else:
        args += ["-f", "s16le", "-ar", "44100", "-ac", "1", "-i", "pipe:0"]
        payload = _pcm16(seconds)
    args += ["-t", str(seconds)]

    if codec in ("mp4", "m4a"):
        # `ipod` is the m4a (AAC) muxer ffmpeg ships; `mp4` is the muxer name.
        muxer = "ipod" if codec == "m4a" else "mp4"
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / f"clip.{codec}"
            proc = subprocess.run(
                args + ["-f", muxer, str(target)],
                input=payload,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=120,
            )
            if proc.returncode != 0 or not target.is_file():
                pytest.skip(f"ffmpeg cannot write {codec}: {proc.stderr.decode()[:200]}")
            return target.read_bytes()

    proc = subprocess.run(
        args + ["-f", codec, "pipe:1"],
        input=payload,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=120,
    )
    if proc.returncode != 0 or not proc.stdout:
        pytest.skip(f"ffmpeg cannot write {codec}: {proc.stderr.decode()[:200]}")
    return proc.stdout


#: The containers the worker can send. `assets/youtube_clips` and the clone
#: upload route accept mp3/m4a/webm/ogg/flac/wav, and Fish's own reference
#: clips are commonly m4a or webm.
CONTAINERS = ["mp3", "m4a", "ogg", "flac", "webm", "wav"]


@pytest.fixture(scope="module")
def encoded() -> dict[str, bytes]:
    return {name: _encode(name) for name in CONTAINERS}


# ── the containers really decode ──────────────────────────────────────────


@pytest.mark.parametrize("container", CONTAINERS)
def test_every_container_the_worker_sends_decodes(container, encoded):
    pcm, rate, channels = decode_reference_samples(encoded[container])
    assert rate == REFERENCE_DECODE_RATE
    assert channels == 1, "a mono contract stops interleaved stereo playing at 2x"
    assert len(pcm) % 2 == 0
    seconds = len(pcm) / 2 / rate
    assert seconds == pytest.approx(3.0, abs=0.15), f"{container} decoded to {seconds}s"


@pytest.mark.parametrize("container", CONTAINERS)
def test_encoded_references_pass_validation(container, encoded):
    """Not just "does not raise": the measured numbers must be right.

    This is the assertion the old code could not make for a non-WAV clip,
    because `reference_stats` returned `seconds: None, rms: None` and every
    amplitude rule silently skipped.
    """
    stats = validate_reference_audio(encoded[container])
    assert stats["seconds"] == pytest.approx(3.0, abs=0.2), container
    assert stats["rms"] > 0.05, f"{container} measured rms {stats['rms']}"
    assert stats["peak"] > 0.2
    if container != "wav":
        assert stats["format"] == "decoded"
        assert stats["container"] == container


def test_a_wav_skips_the_decoder():
    """A WAV must not pay a subprocess: it is already PCM."""
    stats = validate_reference_audio(_wav(3.0))
    assert stats["format"] == "wav"
    assert stats["container"] == "wav"


def test_stereo_is_downmixed_not_interleaved():
    stereo = _wav(2.0, channels=2)
    pcm, rate, channels = decode_reference_samples(stereo)
    assert channels == 1
    # 2 s of mono, not 2 s of interleaved stereo read as double-length mono.
    assert len(pcm) / 2 / rate == pytest.approx(2.0, abs=0.05)


def test_a_video_container_yields_only_its_audio():
    """`-vn` matters: an MP4 with a cover image has a video stream too."""
    mp4 = _encode("mp4")
    pcm, rate, _ = decode_reference_samples(mp4)
    assert len(pcm) / 2 / rate == pytest.approx(3.0, abs=0.2)


# ── failures are named, not 500s ──────────────────────────────────────────


@pytest.mark.parametrize("container", ["mp3", "m4a", "ogg", "flac", "webm"])
def test_digital_silence_is_rejected_whatever_the_container(container):
    """The byte rules could never catch this: a silent MP3 is full of bytes.

    Ten seconds so a low-bitrate codec still clears `REFERENCE_MIN_BYTES`;
    otherwise the size floor would be the rule under test, not the amplitude.
    """
    silent = _encode(container, 10.0, silence=True)
    with pytest.raises(ReferenceClipError) as err:
        validate_reference_audio(silent)
    assert "silent" in str(err.value), str(err.value)


def test_a_truncated_mp3_reports_the_container():
    """A truncated upload must be a named 422, not a decoder traceback."""
    # Cut inside the first frame, so there is not one complete MPEG frame.
    truncated = _encode("mp3", 3.0)[:300]
    with pytest.raises(ReferenceClipError) as err:
        decode_reference_samples(truncated)
    message = str(err.value)
    assert "mp3" in message, message
    assert "metadata_errors" not in message


def test_a_missing_ffmpeg_is_a_named_error(encoded):
    with pytest.raises(ReferenceClipError) as err:
        decode_reference_samples(encoded["mp3"], ffmpeg="/nonexistent/ffmpeg")
    assert "ffmpeg is not available" in str(err.value)
    assert "mp3" in str(err.value)


def test_the_container_type_is_recognised_from_bytes(encoded):
    for name in CONTAINERS:
        assert reference_container(encoded[name]) == name, name


# ── the structural guard ──────────────────────────────────────────────────


def test_the_reference_path_never_touches_pyav_or_torchaudio():
    """The exact bug, as a guard rather than a comment.

    `torchaudio.load` is PyAV-backed on this image, and `av.open` is where the
    unsupported `metadata_errors` kwarg came from. Decoding now goes through
    ffmpeg (`s2_contract`) so neither can reappear on a reference path without
    this failing.

    Checked on the parsed AST, not the source text: the docstrings deliberately
    name both libraries to explain what went wrong.
    """
    module = _batch_module()
    for name in ("encode_reference", "transcribe_reference"):
        function = next(
            node
            for node in ast.walk(ast.parse(textwrap.dedent(
                inspect.getsource(getattr(module._BatchEngine, name))
            )))
            if isinstance(node, ast.FunctionDef)
        )
        source = ast.unparse(function)

        banned = {
            alias.name.split(".")[0]
            for node in ast.walk(function)
            if isinstance(node, (ast.Import, ast.ImportFrom))
            for alias in node.names
        }
        assert not banned & {"torchaudio", "av"}, f"{name} imports {banned & {'torchaudio', 'av'}}"
        calls = {
            node.func.attr
            for node in ast.walk(function)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        }
        assert "load" not in calls or "torchaudio" not in source
        assert "open" not in calls, f"{name} must not open a container itself"
        kwargs = {
            keyword.arg
            for node in ast.walk(function)
            if isinstance(node, ast.Call)
            for keyword in node.keywords
        }
        assert "metadata_errors" not in kwargs
        # And it must actually use the decoder this file just proved works.
        assert "reference_float_samples" in source or "decode_reference_samples" in source


def test_no_call_site_passes_the_removed_pyav_kwarg():
    """PyAV 19 removed `metadata_errors`; pinning the wheel is the weaker fix.

    Blunt on purpose: the whole image runs one PyAV, so any call site that
    passes the argument as a keyword is broken there. Comments and docstrings
    that *name* the bug are fine — only real keyword arguments count.
    """
    root = __import__("pathlib").Path(__file__).parent
    offenders: list[str] = []
    for path in root.glob("*.py"):
        if path.name.startswith("test_"):
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and any(
                keyword.arg == "metadata_errors" for keyword in node.keywords
            ):
                offenders.append(f"{path.name}:{node.lineno}")
    assert offenders == [], (
        f"metadata_errors is unsupported on the pinned PyAV: {offenders}"
    )


def test_the_standard_library_decoder_still_reads_what_the_pipeline_writes(tmp_path):
    """`decode_reference_samples` and `reference_stats` must agree on a WAV."""
    path = tmp_path / "clip.wav"
    path.write_bytes(_wav(3.0))
    audio = path.read_bytes()
    via_stats = reference_stats(audio)
    via_decode = decoded_reference_stats(audio)
    assert via_decode["seconds"] == pytest.approx(via_stats["seconds"], abs=1e-6)
    assert via_decode["rms"] == pytest.approx(via_stats["rms"], abs=1e-6)


# ── the service reports what it decoded ───────────────────────────────────


def test_the_service_reports_decoded_reference_stats():
    """An operator triaging a bad book needs the container and the numbers.

    `reference_stats` returned `seconds: None, rms: None` for every non-WAV
    clip, so the response for `job 5f09ee0e` could not say whether the
    reference was too short, silent, or simply not decoded at all.
    """
    import s2_clone_service

    mp3 = _encode("mp3", 3.0)
    stats = s2_clone_service.decoded_reference_stats(mp3)
    assert stats["container"] == "mp3"
    assert stats["seconds"] == pytest.approx(3.0, abs=0.2)
    assert stats["rms"] > 0.05


def test_prepare_reference_names_an_undecodable_clip():
    """`_prepare_reference` is the pre-GPU gate; it must fail as a 422.

    The service maps `ReferenceClipError` to a 422 with the message, so naming
    the container here is what turns a 500 into an actionable error.
    """
    import s2_clone_service
    from s2_contract import ReferenceClipError

    broken = b"ID3" + bytes(range(1, 250)) * 200
    with pytest.raises(ReferenceClipError) as err:
        s2_clone_service._prepare_reference(broken, "some transcript")
    assert "mp3" in str(err.value)
    assert "metadata_errors" not in str(err.value)


# ── the samples handed to the codec and to Whisper ─────────────────────────


@pytest.mark.parametrize("container", CONTAINERS)
def test_float_samples_are_normalised_and_resampled(container, encoded):
    """`encode_reference`/`transcribe_reference` take these samples directly."""
    from s2_contract import reference_float_samples

    samples = reference_float_samples(encoded[container], target_rate=16_000)
    assert samples, container
    assert len(samples) == pytest.approx(16_000 * 3.0, rel=0.1), container
    assert all(-1.0 <= s <= 1.0 for s in samples), container
    # A tone burst, not silence: the codec needs real audio to prompt a voice.
    peak = max(abs(s) for s in samples)
    assert peak > 0.2, f"{container} peak {peak}"


def test_resample_keeps_duration_and_rejects_nothing(encoded):
    from s2_contract import reference_float_samples

    for target in (16_000, 22_050, 44_100, 48_000):
        samples = reference_float_samples(encoded["mp3"], target_rate=target)
        seconds = len(samples) / target
        assert seconds == pytest.approx(3.0, abs=0.15), target


def test_a_sine_survives_resampling():
    """A nearest-neighbour stub would pass length checks and fail this."""
    from s2_contract import reference_float_samples

    # 3 s of 180 Hz at 44.1 kHz, written as a WAV the stdlib reader handles.
    frames = int(3 * 44_100)
    samples = [int(20_000 * math.sin(2 * math.pi * 180 * i / 44_100)) for i in range(frames)]
    audio = _wav_bytes(samples)
    out = reference_float_samples(audio, target_rate=16_000)
    # Count zero crossings: the tone is unchanged by a correct ratio, so the
    # crossing count must scale with the new sample rate, not the old one.
    crossings = sum(
        1 for a, b in zip(out, out[1:]) if (a < 0) != (b < 0)
    )
    expected = 2 * 180 * 3.0  # two crossings per cycle
    assert crossings == pytest.approx(expected, rel=0.05)
    # And the amplitude is preserved rather than smeared away.
    assert max(abs(s) for s in out) > 0.5


def _wav_bytes(samples: list[int], rate: int = 44_100) -> bytes:
    import io

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    return buf.getvalue()


# ── the real encode_reference, with a stubbed codec ───────────────────────


class _Array:
    """Just enough of a tensor for the reshape/`to` pipeline in `encode_reference`."""

    def __init__(self, shape, length=None) -> None:
        self.shape = shape
        self._length = length if length is not None else shape[0]

    def reshape(self, *shape):
        """Resolve a single `-1` the way torch does, so the length is testable."""
        dims = list(shape)
        if -1 in dims:
            known = 1
            for d in dims:
                if d != -1:
                    known *= d
            dims[dims.index(-1)] = self._length // max(1, known)
        return _Array(tuple(dims), self._length)

    def to(self, device=None, dtype=None):
        return self

    def __int__(self) -> int:
        return self._length


def _install_torch_for_encode(decode_module) -> None:
    """Fill the gaps in the suite's torch stub that `encode_reference` needs."""
    torch = sys.modules["torch"]
    torch.from_numpy = lambda array: _Array((len(array),))
    torch.tensor = lambda values, device=None, dtype=None: _Array(
        (1,), values[0] if values else 0
    )

    class _NoGrad:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    torch.no_grad = _NoGrad
    if not hasattr(torch, "inference_mode"):
        torch.inference_mode = _NoGrad
    torch.long = getattr(torch, "long", "torch.long")


class _StubDecoder:
    """Records what reaches the codec; the codec itself needs a GPU."""

    def __init__(self) -> None:
        self.shape = None

    def parameters(self):
        return iter([types.SimpleNamespace(dtype="bf16")])

    def encode(self, audios, lengths):
        # The real codec wants (B, 1, T) and a parallel length tensor.
        self.shape = (audios.shape, lengths)
        return [[types.SimpleNamespace(cpu=lambda: "codes")]]


def test_encode_reference_accepts_every_container_the_worker_sends(encoded):
    """The method that raised `TypeError` on `job 5f09ee0e`, driven for real.

    Torch is only used for `from_numpy` and a reshape here, so a minimal stub
    is enough to prove the decode → resample → codec handoff for each
    container. Before the fix this raised before reaching the codec at all,
    because `torchaudio.load` went through `av.open`.
    """
    module = _batch_module()
    _install_torch_for_encode(module)

    engine = module._BatchEngine.__new__(module._BatchEngine)
    engine.decoder = _StubDecoder()
    engine.sample_rate = 44_100
    engine.device = "cuda"

    for container in CONTAINERS:
        engine.decoder.shape = None
        codes = module._BatchEngine.encode_reference(engine, encoded[container])
        assert codes == "codes", container
        shape, lengths = engine.decoder.shape
        # One row, one channel, ~3 s at the model rate.
        assert shape[0] == 1 and shape[1] == 1, (container, shape)
        assert shape[2] == pytest.approx(44_100 * 3.0, rel=0.1), (container, shape)
        assert int(lengths) == shape[2], container


def test_transcribe_reference_passes_samples_not_a_file(encoded):
    """`faster-whisper` would decode a path through the broken `av.open`.

    Its `transcribe()` only skips its own decoder when `audio` is already a
    numpy array, so this asserts the type that keeps PyAV out of the path.
    """
    numpy = pytest.importorskip("numpy")
    module = _batch_module()

    seen: list[object] = []

    class _Whisper:
        def transcribe(self, audio, **kwargs):
            seen.append(audio)
            return iter([types.SimpleNamespace(text=" hello there ")]), None

    engine = module._BatchEngine.__new__(module._BatchEngine)
    engine.whisper = _Whisper()

    text = module._BatchEngine.transcribe_reference(engine, encoded["mp3"])
    assert text == "hello there"
    (audio,) = seen
    assert isinstance(audio, numpy.ndarray), type(audio)
    # 16 kHz mono floats, which is what Whisper expects.
    assert audio.dtype == numpy.float32
    assert len(audio) / 16_000 == pytest.approx(3.0, abs=0.2)
