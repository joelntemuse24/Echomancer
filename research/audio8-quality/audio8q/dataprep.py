"""Build breath-free fine-tuning data from public-domain / CC-BY audiobook speech.

The brief's constraint is that the fix must generalise: a LoRA trained on one
narrator's clean speech would drag the model toward that narrator and weaken
zero-shot cloning. So the corpus is deliberately many speakers, many channels,
and every breath in it is removed by measurement rather than by hand:

  1. LibriSpeech dev-clean + test-clean (16 kHz, CC-BY 4.0, 40+ speakers,
     5.4 h combined). It is the smallest public set that already has exact
     transcripts and the speaker variety we want.
  2. Each utterance is checked for breath runs with the same detector the eval
     uses. Runs that land inside a word's voiced core are *not* touched (they
     are fricatives); runs in pauses, and inhale-shaped runs at a sentence
     onset, are replaced with a matched-length piece of the utterance's own
     noise floor, faded so the edit cannot click.
  3. Clips with a residual breath density above the threshold are dropped rather
     than heavily edited, because a take that needed five edits is not a good
     "breath-free" target.
  4. Everything is resampled to 44.1 kHz mono, loudness-normalised to -20 LUFS,
     and written as 16-bit wav next to a JSON manifest with the exact transcript.

`silence-replacement` rather than digital silence matters: a model trained on
hard zeros learns to produce hard zeros, which sounds gated.

The same code runs on CPU in seconds per hour of audio, so the dataset can be
built and spot-checked before any GPU is touched.
"""

from __future__ import annotations

import glob
import json
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .frames import SAMPLE_RATE
from .probes import detect_breaths

TARGET_RATE = SAMPLE_RATE  # 44100
LUFS_TARGET = -20.0
MIN_CLIP_S = 3.0
MAX_CLIP_S = 18.0
MAX_RESIDUAL_BREATHS = 1


@dataclass
class Clip:
    id: str
    wav: str
    text: str
    speaker: str
    seconds: float
    breaths_before: int
    breaths_after: int
    edits: int

    def as_dict(self) -> dict:
        return dict(
            id=self.id,
            wav=self.wav,
            text=self.text,
            speaker=self.speaker,
            seconds=round(self.seconds, 2),
            breaths_before=self.breaths_before,
            breaths_after=self.breaths_after,
            edits=self.edits,
        )


def librispeech_pairs(root: str, splits: tuple[str, ...] = ("dev-clean", "test-clean")) -> list[dict]:
    """(flac, transcript) pairs with the LibriSpeech id split from its line."""
    out: list[dict] = []
    for split in splits:
        for trans in sorted(glob.glob(os.path.join(root, "LibriSpeech", split, "*", "*", "*.trans.txt"))):
            folder = os.path.dirname(trans)
            speaker = Path(folder).parent.name
            for line in Path(trans).read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                uid, text = line.split(" ", 1)
                flac = os.path.join(folder, uid + ".flac")
                if os.path.exists(flac):
                    out.append(dict(id=uid, wav=flac, text=text.strip(), speaker=speaker, split=split))
    return out


def _noise_floor(
    audio: np.ndarray,
    sr: int = TARGET_RATE,
    avoid: list[tuple[float, float]] | None = None,
    speech_db: float | None = None,
) -> np.ndarray:
    """A piece of the clip's own quietest audio, used as the replacement bed.

    Windows that overlap a breath candidate are skipped, so the bed cannot be the
    breath that is about to be removed. The chosen window must also be at least
    30 dB below the clip's speech level; if the whole clip is loud (a single
    sustained tone, or continuous music), no real floor exists and a shaped
    -72 dBFS noise floor is synthesised instead. Either way the bed is never
    digital silence, which is what keeps a model trained on this data from
    learning to emit hard zeros.
    """
    import librosa

    if speech_db is None:
        loud = 20.0 * np.log10(np.sqrt((audio**2).mean()) + 1e-12)
        speech_db = loud
    hop = 512
    rms = librosa.feature.rms(y=audio, frame_length=2048, hop_length=hop)[0]
    window = max(1, int(0.5 * sr / hop))
    if rms.size >= window:
        smooth = np.convolve(rms, np.ones(window) / window, mode="valid")
        for candidate in np.argsort(smooth):
            level = 20.0 * np.log10(smooth[candidate] + 1e-12)
            if level > speech_db - 30.0:
                break  # nothing quiet enough; fall through to synthesised floor
            start = int(candidate) * hop
            stop = start + int(0.5 * sr)
            if stop > len(audio):
                continue
            centre = (start + stop) / 2.0 / sr
            if avoid and any(a - 0.1 <= centre <= b + 0.1 for a, b in avoid):
                continue
            return np.asarray(audio[start:stop], dtype=np.float32)
    rng = np.random.default_rng(0)
    noise = rng.standard_normal(int(0.5 * sr)).astype(np.float32)
    noise = librosa.effects.preemphasis(noise, coef=0.9).astype(np.float32)
    return noise * (10 ** (-72 / 20.0) / max(1e-9, float(np.abs(noise).max())))


def remove_breaths(
    audio: np.ndarray,
    *,
    sr: int = TARGET_RATE,
    fade_ms: float = 12.0,
    keep_word_runs: bool = True,
) -> tuple[np.ndarray, dict]:
    """Replace detected breath runs with the clip's own noise floor.

    Runs classified `inside-word` are left alone: those are fricatives, not
    breaths, and editing them would damage the phoneme. Every other run is
    crossfaded out, filled with a matching span of the noise bed, and
    crossfaded back in, so the edit cannot click.
    """
    out = np.asarray(audio, dtype=np.float32).copy()
    report = detect_breaths(out)
    bed = _noise_floor(
        out, sr, avoid=[(c.t, c.t + c.dur) for c in report.candidates if c.kind != "inside-word"]
    )
    fade = max(1, int(fade_ms / 1000.0 * sr))
    ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
    edits = 0
    kept = 0
    for cand in report.candidates:
        if keep_word_runs and cand.kind == "inside-word":
            kept += 1
            continue
        start = int(cand.t * sr)
        stop = min(len(out), start + int(cand.dur * sr))
        if stop - start < int(0.03 * sr):
            continue
        lo = max(0, start - fade)
        hi = min(len(out), stop + fade)
        original = out[lo:hi].copy()
        filler = np.resize(bed, hi - lo).astype(np.float32)
        blended = filler.copy()
        head = min(fade, hi - lo)
        blended[:head] = filler[:head] * ramp[:head] + original[:head] * (1.0 - ramp[:head])
        tail = min(fade, hi - lo)
        blended[-tail:] = filler[-tail:] * ramp[::-1][-tail:] + original[-tail:] * (1.0 - ramp[::-1][-tail:])
        out[lo:hi] = blended
        edits += 1
    return out, dict(breaths_before=report.total, edits=edits, kept_word_runs=kept)


def loudness_normalise(audio: np.ndarray, sr: int = TARGET_RATE, target_lufs: float = LUFS_TARGET) -> np.ndarray:
    """Peak-safe gain to an approximate integrated loudness.

    pyloudnorm is optional; without it this falls back to an RMS proxy so the
    pipeline still runs in a bare environment. The Modal image installs
    pyloudnorm, so production data uses the real meter.
    """
    audio = np.asarray(audio, dtype=np.float32)
    try:
        import pyloudnorm as pyln

        meter = pyln.Meter(sr)
        loudness = meter.integrated_loudness(audio)
        if np.isfinite(loudness):
            audio = pyln.normalize.loudness(audio, loudness, target_lufs)
    except Exception:
        rms = float(np.sqrt((audio**2).mean()) + 1e-12)
        audio = audio * (10 ** ((target_lufs + 23.0) / 20.0) / rms)
    peak = float(np.abs(audio).max())
    if peak > 0.89:
        audio = audio * (0.89 / peak)
    return audio.astype(np.float32)


def prepare_clip(
    src: str,
    text: str,
    *,
    clip_id: str,
    speaker: str,
    out_wav: str,
) -> Clip | None:
    """Load, de-breath, normalise, and write one training clip."""
    import librosa
    import soundfile as sf

    audio, _ = librosa.load(src, sr=TARGET_RATE, mono=True)
    seconds = len(audio) / TARGET_RATE
    if seconds < MIN_CLIP_S or seconds > MAX_CLIP_S:
        return None
    cleaned, info = remove_breaths(audio)
    cleaned = loudness_normalise(cleaned)
    residual = detect_breaths(cleaned)
    if residual.total > MAX_RESIDUAL_BREATHS:
        return None
    Path(out_wav).parent.mkdir(parents=True, exist_ok=True)
    sf.write(out_wav, cleaned, TARGET_RATE, subtype="PCM_16")
    return Clip(
        id=clip_id,
        wav=out_wav,
        text=text,
        speaker=speaker,
        seconds=seconds,
        breaths_before=info["breaths_before"],
        breaths_after=residual.total,
        edits=info["edits"],
    )


def _prepare_job(job):
    item, out_wav = job
    return prepare_clip(item["wav"], item["text"], clip_id=item["id"], speaker=item["speaker"], out_wav=out_wav)


def build_dataset(
    librispeech_root: str,
    out_dir: str,
    *,
    limit: int | None = None,
    splits: tuple[str, ...] = ("dev-clean", "test-clean"),
    workers: int | None = None,
) -> dict:
    """Make the whole corpus and write `manifest.json`, one process per core."""
    pairs = librispeech_pairs(librispeech_root, splits)
    if limit:
        # stride through the sorted list so a subset still spans every speaker
        step = max(1, len(pairs) // limit)
        pairs = pairs[::step][:limit]
    clips: list[Clip] = []
    skipped = dict(too_short=0, too_long=0, residual_breaths=0)
    workers = workers or max(1, (os.cpu_count() or 1))
    jobs = [(item, os.path.join(out_dir, "wav", item["id"] + ".wav")) for item in pairs]
    if workers > 1:
        from concurrent.futures import ProcessPoolExecutor

        with ProcessPoolExecutor(max_workers=workers) as pool:
            results = list(pool.map(_prepare_job, jobs, chunksize=8))
    else:
        results = [_prepare_job(job) for job in jobs]
    for (item, _), clip in zip(jobs, results):
        if clip is None:
            import librosa

            duration = librosa.get_duration(path=item["wav"])
            if duration < MIN_CLIP_S or duration > MAX_CLIP_S:
                skipped["too_short" if duration < MIN_CLIP_S else "too_long"] += 1
            else:
                skipped["residual_breaths"] += 1
            continue
        clips.append(clip)
    manifest = dict(
        root=out_dir,
        clips=[c.as_dict() for c in clips],
        speakers=sorted({c.speaker for c in clips}),
        total_seconds=round(sum(c.seconds for c in clips), 1),
        breaths_removed=sum(c.breaths_before for c in clips),
        skipped=skipped,
    )
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=1)
    return manifest
