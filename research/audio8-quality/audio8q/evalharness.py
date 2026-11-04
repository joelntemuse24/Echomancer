"""The eval harness: one JSON record per take, plus paired comparison.

Every metric the acceptance criteria name is produced here:

  breath_candidates        breath2-style detector, level-relative, unvoiced runs
  pause_ah                 breath runs classified as the soft "ahh" after a sentence
  pre_sentence_inhale      breath runs starting inside the next sentence's first word
  ticks_per_pause_minute   narrow HF impulses per minute of quiet audio
  quiet_hf_crest_db        loudest HF sample inside a quiet frame
  wer                      faster-whisper normalised WER
  speaker_similarity       ECAPA cosine to the reference clip

Nothing in here needs a GPU, so the whole harness runs on a laptop against saved
wavs. The Modal scripts call the same functions, so a GPU number and a CPU
number are directly comparable.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from .frames import SAMPLE_RATE, frame_db, speech_level_db
from .probes import (
    detect_breaths,
    detect_ticks,
    hf_crest_db,
    quiet_hf_crest_db,
    speech_band_balance,
)

# Acceptance thresholds, from the task brief. These are the numbers that decide
# success, so they live next to the code that measures them.
TARGETS = dict(
    breath_candidates_ratio=0.5,  # at least half of the baseline count must go
    pause_ah_max=1,  # absolute, per 27-line set
    ticks_per_pause_minute_max=2.0,
    wer_max=0.03,
    speaker_similarity_drop_max=0.02,
)


@dataclass
class Take:
    name: str
    text_id: str
    wav: str
    seed: int = 0
    variant: str = "base"
    audio_seconds: float = 0.0
    breath_candidates: int = 0
    breath_loud: int = 0
    pause_ah: int = 0
    pre_sentence_inhale: int = 0
    ticks: int = 0
    quiet_seconds: float = 0.0
    ticks_per_pause_minute: float = 0.0
    quiet_hf_crest_db: float = -200.0
    hf_crest_db: float = -200.0
    voiced_8_12k_vs_1_4k_db: float = 0.0
    wer: float | None = None
    insertions: int = 0
    deletions: int = 0
    substitutions: int = 0
    speaker_similarity: float | None = None
    extra: dict = field(default_factory=dict)


def _duration(path: str) -> float:
    import soundfile as sf

    info = sf.info(path)
    return float(info.frames) / float(info.samplerate)


def analyse_audio(
    wav: str,
    *,
    words: list[tuple[str, float, float]] | None = None,
) -> dict:
    """Acoustic metrics only: no ASR, no speaker model. Runs in a second or two."""
    import soundfile as sf

    audio, sr = sf.read(wav, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != SAMPLE_RATE:
        import librosa

        audio = librosa.resample(audio, orig_sr=sr, target_sr=SAMPLE_RATE)
    breaths = detect_breaths(audio, words)
    ticks = detect_ticks(audio)
    return dict(
        audio_seconds=round(float(len(audio)) / SAMPLE_RATE, 2),
        breath_candidates=breaths.total,
        breath_loud=breaths.loud,
        pause_ah=breaths.pause_ah,
        pre_sentence_inhale=breaths.inhales,
        ticks=ticks.ticks,
        quiet_seconds=round(ticks.quiet_seconds, 2),
        ticks_per_pause_minute=round(ticks.ticks_per_pause_minute, 2),
        quiet_hf_crest_db=round(quiet_hf_crest_db(audio), 1),
        hf_crest_db=round(hf_crest_db(audio), 1),
        **speech_band_balance(audio),
    )


def transcribe_words(wav: str, model_size: str = "small.en", threads: int = 4):
    """faster-whisper transcript plus word times, at 16 kHz."""
    import librosa
    from faster_whisper import WhisperModel

    audio, _ = librosa.load(wav, sr=16000, mono=True)
    model = WhisperModel(model_size, device="cpu", compute_type="int8", cpu_threads=threads)
    segments, _ = model.transcribe(
        audio, beam_size=5, language="en", word_timestamps=True, condition_on_previous_text=False
    )
    text_parts: list[str] = []
    words: list[tuple[str, float, float]] = []
    for seg in segments:
        text_parts.append(seg.text.strip())
        for w in seg.words or []:
            words.append((w.word.strip(), float(w.start), float(w.end)))
    return " ".join(p for p in text_parts if p), words


def score_wer(hypothesis: str, reference: str) -> dict:
    import jiwer
    from whisper_normalizer.english import EnglishTextNormalizer

    norm = EnglishTextNormalizer()
    out = jiwer.process_words(norm(reference), norm(hypothesis))
    return dict(
        wer=round(float(out.wer), 4),
        insertions=int(out.insertions),
        deletions=int(out.deletions),
        substitutions=int(out.substitutions),
    )


class SpeakerScorer:
    """ECAPA cosine similarity, loaded once per process.

    speechbrain is heavy, so this is optional: when it cannot be imported the
    harness records similarity as null rather than failing a run.
    """

    def __init__(self, savedir: str | None = None):
        self._model = None
        self._savedir = savedir or os.environ.get("ECAPA_DIR", str(Path(tempfile.gettempdir()) / "ecapa"))

    def _ensure(self):
        if self._model is None:
            import torch
            from speechbrain.inference.speaker import EncoderClassifier

            self._model = EncoderClassifier.from_hparams(
                source="speechbrain/spkrec-ecapa-voxceleb",
                savedir=self._savedir,
                run_opts={"device": "cpu"},
            )
        return self._model

    def embed(self, wav: str) -> np.ndarray:
        import librosa
        import torch

        model = self._ensure()
        audio, _ = librosa.load(wav, sr=16000, mono=True, duration=60)
        with torch.inference_mode():
            emb = model.encode_batch(torch.tensor(audio)[None]).squeeze()
        return emb.cpu().numpy()

    def similarity(self, reference: str, candidate: str) -> float | None:
        try:
            a, b = self.embed(reference), self.embed(candidate)
        except Exception:
            return None
        denom = float(np.linalg.norm(a) * np.linalg.norm(b))
        if denom == 0:
            return None
        return round(float(np.dot(a, b) / denom), 4)


def evaluate_take(
    wav: str,
    *,
    reference_text: str,
    reference_wav: str | None = None,
    speaker: SpeakerScorer | None = None,
    whisper: str = "small.en",
    name: str | None = None,
    text_id: str = "",
    seed: int = 0,
    variant: str = "base",
    use_words: bool = True,
) -> Take:
    """Full record for one wav: acoustic + WER + speaker similarity."""
    hypothesis, words = transcribe_words(wav, whisper)
    take = Take(
        name=name or Path(wav).stem,
        text_id=text_id,
        wav=str(wav),
        seed=seed,
        variant=variant,
    )
    for key, value in analyse_audio(wav, words=words if use_words else None).items():
        setattr(take, key, value)
    for key, value in score_wer(hypothesis, reference_text).items():
        setattr(take, key, value)
    if reference_wav and speaker is not None:
        take.speaker_similarity = speaker.similarity(reference_wav, wav)
    take.extra["hypothesis"] = hypothesis[:400]
    take.extra["words"] = len(words)
    return take


def summarise(takes: list[Take]) -> dict:
    """Aggregate a variant across texts and seeds."""
    if not takes:
        return {}
    def mean(key):
        vals = [getattr(t, key) for t in takes if getattr(t, key) is not None]
        return round(float(np.mean(vals)), 4) if vals else None

    return dict(
        takes=len(takes),
        audio_seconds=round(sum(t.audio_seconds for t in takes), 1),
        breath_candidates=mean("breath_candidates"),
        breath_loud=mean("breath_loud"),
        pause_ah=mean("pause_ah"),
        pre_sentence_inhale=mean("pre_sentence_inhale"),
        ticks=mean("ticks"),
        ticks_per_pause_minute=mean("ticks_per_pause_minute"),
        quiet_hf_crest_db=mean("quiet_hf_crest_db"),
        wer=mean("wer"),
        insertions=mean("insertions"),
        deletions=mean("deletions"),
        speaker_similarity=mean("speaker_similarity"),
    )


def compare(baseline: list[Take], candidate: list[Take]) -> dict:
    """Decide pass/fail for a candidate against a baseline and the TARGETS."""
    b, c = summarise(baseline), summarise(candidate)
    if not b or not c:
        return dict(ok=False, reason="empty take list")

    def ratio(key):
        if not b.get(key):
            return None
        return round(float(c[key]) / float(b[key]), 3)

    checks = {
        "breath_candidates": dict(
            baseline=b["breath_candidates"],
            candidate=c["breath_candidates"],
            ratio=ratio("breath_candidates"),
            target=f"<= {TARGETS['breath_candidates_ratio']}x baseline",
            pass_=bool(ratio("breath_candidates") is not None and ratio("breath_candidates") <= TARGETS["breath_candidates_ratio"]),
        ),
        "pause_ah": dict(
            baseline=b["pause_ah"],
            candidate=c["pause_ah"],
            target=f"<= {TARGETS['pause_ah_max']}",
            pass_=bool(c["pause_ah"] <= TARGETS["pause_ah_max"]),
        ),
        "ticks_per_pause_minute": dict(
            baseline=b["ticks_per_pause_minute"],
            candidate=c["ticks_per_pause_minute"],
            target=f"<= {TARGETS['ticks_per_pause_minute_max']}",
            pass_=bool(c["ticks_per_pause_minute"] <= TARGETS["ticks_per_pause_minute_max"]),
        ),
        "wer": dict(
            baseline=b["wer"],
            candidate=c["wer"],
            target=f"<= {TARGETS['wer_max']}",
            pass_=bool(c["wer"] is not None and c["wer"] <= TARGETS["wer_max"]),
        ),
        "speaker_similarity": dict(
            baseline=b["speaker_similarity"],
            candidate=c["speaker_similarity"],
            drop=(round(float(b["speaker_similarity"]) - float(c["speaker_similarity"]), 4)
                  if b.get("speaker_similarity") is not None and c.get("speaker_similarity") is not None else None),
            target=f"no worse than -{TARGETS['speaker_similarity_drop_max']} vs baseline",
            pass_=bool(
                b.get("speaker_similarity") is not None
                and c.get("speaker_similarity") is not None
                and (float(b["speaker_similarity"]) - float(c["speaker_similarity"])) <= TARGETS["speaker_similarity_drop_max"]
            ),
        ),
    }
    ok = all(v["pass_"] for v in checks.values())
    return dict(ok=ok, baseline=b, candidate=c, checks=checks)


def write_json(path: str | Path, payload) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=1, default=_default)


def _default(obj):
    if isinstance(obj, Take):
        return asdict(obj)
    if isinstance(obj, np.generic):
        return obj.item()
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    raise TypeError(f"not serialisable: {type(obj)}")


def takes_from_dir(
    directory: str,
    *,
    reference_texts: dict[str, str],
    reference_wav: str | None = None,
    speaker: SpeakerScorer | None = None,
    whisper: str = "small.en",
    pattern: str = "*.wav",
) -> list[Take]:
    """Evaluate every `{variant}__{text_id}__s{seed}.wav` in a directory.

    The filename convention is what the Modal jobs write, so GPU output can be
    scored locally without any bookkeeping beyond dropping the wavs in a folder.
    """
    out: list[Take] = []
    for path in sorted(Path(directory).glob(pattern)):
        parts = path.stem.split("__")
        variant = parts[0] if len(parts) > 0 else "base"
        text_id = parts[1] if len(parts) > 1 else path.stem
        seed = int(parts[2][1:]) if len(parts) > 2 and parts[2][1:].isdigit() else 0
        text = reference_texts.get(text_id)
        if text is None:
            continue
        out.append(
            evaluate_take(
                str(path),
                reference_text=text,
                reference_wav=reference_wav,
                speaker=speaker,
                whisper=whisper,
                name=path.stem,
                text_id=text_id,
                seed=seed,
                variant=variant,
            )
        )
    return out


def ffmpeg_concat(parts: list[str], out: str, gap_seconds: float = 0.30) -> str:
    """Join per-line wavs with a fixed pause; used to score a whole passage.

    Fixed gaps (rather than the model's own pauses) mean the pause inventory is
    the same for every variant, so a breath count difference is the model's.
    """
    import soundfile as sf

    pieces: list[np.ndarray] = []
    sr = SAMPLE_RATE
    gap = np.zeros(int(gap_seconds * sr), dtype=np.float32)
    for p in parts:
        audio, rate = sf.read(p, dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        if rate != sr:
            import librosa

            audio = librosa.resample(audio, orig_sr=rate, target_sr=sr)
        pieces.append(audio.astype(np.float32))
        pieces.append(gap)
    if not pieces:
        raise ValueError("nothing to join")
    merged = np.concatenate(pieces[:-1])
    sf.write(out, merged, sr, subtype="PCM_16")
    return out
