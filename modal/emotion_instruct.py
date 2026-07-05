"""Rule-based paragraph pacing hints for MOSS-TTS synthesis."""
import re

BASE_SPEED = 0.88
MIN_SPEED = 0.75
MAX_SPEED = 1.0
DEFAULT_CFG_STRENGTH = 2.0
DIALOGUE_CFG_STRENGTH = 2.5


def analyze_paragraph(text: str) -> tuple[float, float]:
    """Return (speed, cfg_strength) hints from paragraph structure."""
    speed = BASE_SPEED
    has_dialogue = '"' in text or '"' in text or '"' in text or "'" in text
    if has_dialogue:
        speed += 0.04

    sentences = re.split(r'(?<=[.!?])\s+', text)
    sentences = [s for s in sentences if s.strip()]
    if sentences:
        avg_words = sum(len(s.split()) for s in sentences) / len(sentences)
        if avg_words < 8:
            speed += 0.05
        comma_count = text.count(',')
        if avg_words > 15 and comma_count >= 2:
            speed -= 0.04

    if '!' in text:
        speed += 0.02
    if '?' in text:
        speed -= 0.02

    words = text.split()
    if words:
        avg_word_len = sum(len(w.strip('.,!?;:"()[]')) for w in words) / len(words)
        if avg_word_len > 6:
            speed -= 0.03

    speed = max(MIN_SPEED, min(MAX_SPEED, speed))
    cfg = DIALOGUE_CFG_STRENGTH if has_dialogue else DEFAULT_CFG_STRENGTH
    return speed, cfg