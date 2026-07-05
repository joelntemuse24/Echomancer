"""Rule-based paragraph pacing and narration style hints for MOSS-TTS."""
import os
import re

BASE_SPEED = float(os.environ.get("MOSS_BASE_SPEED", "0.82"))
MIN_SPEED = 0.75
MAX_SPEED = 1.0
DEFAULT_CFG_STRENGTH = 2.0
DIALOGUE_CFG_STRENGTH = 2.5
PACING_THRESHOLD = float(os.environ.get("MOSS_PACING_THRESHOLD", "0.92"))
SENTENCE_PAUSE_SEC = float(os.environ.get("MOSS_SENTENCE_PAUSE_SEC", "0.22"))
EMDASH_PAUSE_SEC = float(os.environ.get("MOSS_EMDASH_PAUSE_SEC", "0.45"))
SEMICOLON_PAUSE_SEC = float(os.environ.get("MOSS_SEMICOLON_PAUSE_SEC", "0.35"))

MOSS_NARRATION_INSTRUCTIONS = os.environ.get(
    "MOSS_NARRATION_INSTRUCTIONS",
    "Expressive audiobook narration with natural warmth, varied intonation, and unhurried pacing.",
)

MOSS_AUDIO_TEMPERATURE = float(os.environ.get("MOSS_AUDIO_TEMPERATURE", "1.82"))
MOSS_AUDIO_TOP_P = float(os.environ.get("MOSS_AUDIO_TOP_P", "0.85"))
MOSS_AUDIO_TOP_K = int(os.environ.get("MOSS_AUDIO_TOP_K", "28"))


def analyze_paragraph(text: str) -> tuple[float, float]:
    """Return (speed, cfg_strength) hints from paragraph structure."""
    speed = BASE_SPEED
    has_dialogue = '"' in text or '"' in text or '"' in text or "'" in text
    if has_dialogue:
        speed += 0.04

    sentences = re.split(r"(?<=[.!?])\s+", text)
    sentences = [s for s in sentences if s.strip()]
    if sentences:
        avg_words = sum(len(s.split()) for s in sentences) / len(sentences)
        if avg_words < 8:
            speed += 0.05
        comma_count = text.count(",")
        if avg_words > 15 and comma_count >= 2:
            speed -= 0.04

    if "!" in text:
        speed += 0.02
    if "?" in text:
        speed -= 0.02

    words = text.split()
    if words:
        avg_word_len = sum(len(w.strip('.,!?;:"()[]')) for w in words) / len(words)
        if avg_word_len > 6:
            speed -= 0.03

    speed = max(MIN_SPEED, min(MAX_SPEED, speed))
    cfg = DIALOGUE_CFG_STRENGTH if has_dialogue else DEFAULT_CFG_STRENGTH
    return speed, cfg


def apply_moss_pacing(text: str) -> str:
    """
    Insert MOSS [pause] markers for calmer audiobook delivery.

    All prose gets light sentence cadence; denser passages also get em-dash
    and semicolon pauses when the paragraph scores below PACING_THRESHOLD.
    """
    if not text.strip():
        return text

    speed, _ = analyze_paragraph(text)
    paced = text

    # Breath between sentences (skip likely abbreviations like "Dr. Smith")
    paced = re.sub(
        r'(?<![A-Z])([.!?]) (?=[A-Z"\'(])',
        rf"\1 [pause {SENTENCE_PAUSE_SEC}s] ",
        paced,
    )

    if speed < PACING_THRESHOLD:
        paced = re.sub(r" — ", f" — [pause {EMDASH_PAUSE_SEC}s] ", paced)
        paced = re.sub(r"; ", f"; [pause {SEMICOLON_PAUSE_SEC}s] ", paced)

    return paced


def moss_sglang_generation_params(language: str | None = None) -> dict:
    """SGLang /v1/audio/speech params for warmer, less monotone narration."""
    params: dict = {
        "instructions": MOSS_NARRATION_INSTRUCTIONS,
        "audio_temperature": MOSS_AUDIO_TEMPERATURE,
        "audio_top_p": MOSS_AUDIO_TOP_P,
        "audio_top_k": MOSS_AUDIO_TOP_K,
    }
    if language:
        params["language"] = language
    return params