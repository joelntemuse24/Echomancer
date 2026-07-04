"""
Map paragraph text features to Qwen3-TTS CustomVoice `instruct` strings.
Used by the hybrid pipeline (Qwen reader + MeanVC cloner).
"""
import re

BASE_SPEED = 0.88
MIN_SPEED = 0.75
MAX_SPEED = 1.0
DEFAULT_CFG_STRENGTH = 2.0
DIALOGUE_CFG_STRENGTH = 2.5


def analyze_paragraph(text: str) -> tuple[float, float]:
    """Rule-based pacing hints (same logic as f5_tts_server.py)."""
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


def paragraph_to_instruct(text: str, speed: float | None = None, cfg: float | None = None) -> str:
    """
    Build a natural-language instruct string for Qwen3 CustomVoice.
    Qwen handles prosody; MeanVC handles timbre — instruct focuses on reading style.
    """
    if speed is None or cfg is None:
        speed, cfg = analyze_paragraph(text)

    parts: list[str] = [
        "You are narrating an audiobook. Read clearly and naturally.",
    ]

    if speed < 0.82:
        parts.append("Use a slow, deliberate pace with thoughtful pauses.")
    elif speed > 0.92:
        parts.append("Use a slightly faster, energetic pace.")
    else:
        parts.append("Use a calm, steady audiobook narrator pace.")

    if cfg >= DIALOGUE_CFG_STRENGTH - 0.1:
        parts.append("This passage contains dialogue — give quoted speech distinct emphasis.")

    if '!' in text:
        parts.append("Convey excitement or urgency where exclamation marks appear.")
    if '?' in text:
        parts.append("Use rising intonation on questions.")

    if text.count(',') >= 3:
        parts.append("Pause briefly at commas for clarity.")

    return " ".join(parts)