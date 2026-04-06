"""
SML-based Director - No ML, instant response
Inserts pause/break tags based on text patterns
"""

import modal
import re

image = modal.Image.debian_slim().pip_install("fastapi")
app = modal.App("director-sml", image=image)

# Sentence endings that need pauses
ENDINGS = {
    '.': '[pause:0.8]',   # Statement
    '?': '[pause:1.0]',   # Question  
    '!': '[pause:0.6]',   # Exclamation
    '...': '[pause:1.5]', # Ellipsis/drama
    '—': '[pause:1.2]',   # Em-dash
}

@app.function()
@modal.fastapi_endpoint(method="POST")
def analyze(request: dict):
    """Analyze text and insert SML tags for pacing."""
    text = request.get("text", "").strip()
    if not text:
        return {"error": "text is required"}
    
    # Calculate metrics
    words = text.split()
    word_count = len(words)
    
    # Determine speed based on sentence length
    if word_count <= 5:
        speed = 1.15  # Fast for short
    elif word_count >= 20:
        speed = 0.90  # Slow for long
    else:
        speed = 1.0
    
    # Determine energy
    if text.count('!') >= 2 or any(w in text.upper() for w in ['STOP', 'HELP', 'NO']):
        energy = "high"
        speed = 1.15
    elif '...' in text or text.endswith('?'):
        energy = "neutral"
    else:
        energy = "neutral"
    
    # Insert SML tags at sentence boundaries
    modified_text = text
    
    # Add breaks after punctuation (but not inside abbreviations like Mr. Mrs.)
    modified_text = re.sub(r'(?<![A-Z][a-z])(?<=[.!?])(\s+)(?=[A-Z])', r' [pause:0.8]\1', modified_text)
    
    # Add longer pause for paragraph breaks (double newline)
    modified_text = modified_text.replace('\n\n', ' [pause:1.5]\n\n')
    
    # Add dramatic pause for ellipses
    modified_text = modified_text.replace('...', '... [pause:1.2]')
    
    return {
        "modified_text": modified_text,
        "speed": speed,
        "energy": energy,
        "word_count": word_count
    }

@app.function()
@modal.fastapi_endpoint(method="GET")
def health():
    return {"status": "ok", "type": "sml-director"}
