"""
Rule-Based LLM Director - No model loading, instant response
Analyzes text patterns to determine pacing and speed
"""

import modal
import json
import re

image = modal.Image.debian_slim().pip_install("fastapi")

app = modal.App("director-rule-based", image=image)

@app.function()
@modal.fastapi_endpoint(method="POST")
def analyze(request: dict):
    """Analyze text using simple heuristics - INSTANT, no model loading."""
    text = request.get("text", "").strip()
    if not text:
        return {"error": "text is required"}
    
    # Count punctuation markers
    exclamations = text.count("!")
    questions = text.count("?")
    ellipses = text.count("...") + text.count("—")
    commas = text.count(",")
    
    # Calculate word count and sentence length
    words = text.split()
    word_count = len(words)
    sentences = re.split(r'[.!?]+', text)
    sentences = [s.strip() for s in sentences if s.strip()]
    avg_sentence_length = word_count / len(sentences) if sentences else word_count
    
    # Determine energy
    if exclamations >= 2 or "STOP" in text.upper() or "HELP" in text.upper():
        energy = "high"
    elif questions >= 2 or text.endswith("?"):
        energy = "neutral"
    elif ellipses >= 1 or any(word in text.lower() for word in ["sad", "slow", "quiet", "whisper"]):
        energy = "low"
    else:
        energy = "neutral"
    
    # Determine speed
    if energy == "high" or avg_sentence_length < 8:
        speed = 1.15  # Fast for action/short sentences
    elif energy == "low" or ellipses >= 2:
        speed = 0.85  # Slow for suspense/profound
    elif commas >= 3:
        speed = 0.95  # Slightly slower for complex sentences
    else:
        speed = 1.0  # Normal
    
    # Modify punctuation for TTS pacing
    modified_text = text
    
    # Add em-dashes for dramatic pauses (if not present)
    if energy == "low" and "—" not in text:
        modified_text = re.sub(r'\.\.\.', '—', modified_text, count=1)
    
    # Speed up: remove some commas for fast dialogue
    if speed > 1.1 and commas > 2:
        # Remove every other comma
        comma_positions = [m.start() for m in re.finditer(r',', modified_text)]
        for i in range(len(comma_positions) - 1, -1, -2):
            pos = comma_positions[i]
            modified_text = modified_text[:pos] + modified_text[pos+1:]
    
    return {
        "modified_text": modified_text,
        "speed": speed,
        "energy": energy,
        "analysis": {
            "word_count": word_count,
            "sentence_count": len(sentences),
            "exclamations": exclamations,
            "questions": questions,
            "ellipses": ellipses
        }
    }

@app.function()
@modal.fastapi_endpoint(method="GET")
def health():
    return {"status": "ok", "model": "rule-based-director", "load_time": "instant"}
