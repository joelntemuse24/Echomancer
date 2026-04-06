"""
Advanced Emotion Director for Audiobook-Quality Narration
Uses Go-Emotions (28 emotions) + Rhetorical Analysis
"""

import modal

image = (
    modal.Image.debian_slim(python_version="3.10")
    .pip_install("transformers", "torch", "fastapi", "numpy")
)

app = modal.App("emotion-director-v2", image=image)

@app.cls(
    gpu="T4",
    scaledown_window=300,
)
class EmotionDirectorV2:
    @modal.enter()
    def load_model(self):
        """Load Go-Emotions model (more nuanced than basic 6 emotions)"""
        from transformers import pipeline
        import numpy as np
        self.np = np
        
        print("Loading Go-Emotions model...")
        # SamLowe/roberta-base-go_emotions - 28 emotions including:
        # admiration, amusement, anger, annoyance, approval, caring, confusion
        # curiosity, desire, disappointment, disapproval, disgust, embarrassment
        # excitement, fear, gratitude, grief, joy, love, nervousness
        # optimism, pride, realization, relief, remorse, sadness, surprise, neutral
        self.classifier = pipeline(
            "text-classification",
            model="SamLowe/roberta-base-go_emotions",
            top_k=None,
            device=-1  # CPU
        )
        print("Model loaded! Ready for nuanced emotional analysis.")
    
    @modal.fastapi_endpoint(method="POST")
    def analyze(self, request: dict):
        """Advanced emotional and rhetorical analysis for narration"""
        text = request.get("text", "").strip()
        if not text:
            return {"error": "text required"}
        
        try:
            # Get all emotion scores
            results = self.classifier(text[:512])[0]
            
            # Sort by score
            emotions = sorted(results, key=lambda x: x['score'], reverse=True)
            
            # Analyze rhetorical features
            rhetorical = self._analyze_rhetoric(text)
            
            # Determine primary emotional arc
            primary_emotion = emotions[0]['label']
            secondary_emotion = emotions[1]['label'] if len(emotions) > 1 else None
            
            # Calculate nuanced pacing
            pacing = self._calculate_pacing(text, primary_emotion, secondary_emotion, rhetorical)
            
            # Apply sophisticated text markup
            modified_text = self._apply_narration_markup(text, primary_emotion, rhetorical, pacing)
            
            return {
                "modified_text": modified_text,
                "speed": pacing['speed'],
                "energy": pacing['energy'],
                "emotion": primary_emotion,
                "secondary_emotion": secondary_emotion,
                "confidence": round(emotions[0]['score'], 3),
                "all_emotions": {e['label']: round(e['score'], 3) for e in emotions[:5]},
                "rhetorical_features": rhetorical,
                "pacing_notes": pacing['notes']
            }
            
        except Exception as e:
            import traceback
            return {
                "modified_text": text,
                "speed": 1.0,
                "energy": "neutral",
                "emotion": "neutral",
                "error": str(e),
                "traceback": traceback.format_exc()
            }
    
    def _analyze_rhetoric(self, text: str) -> dict:
        """Analyze rhetorical and literary devices"""
        import re
        
        features = {
            "has_question": "?" in text,
            "has_exclamation": "!" in text,
            "has_ellipsis": "..." in text,
            "has_em_dash": "—" in text,
            "has_dialogue": '"' in text or '"' in text or "'" in text,
            "sentence_count": len(re.findall(r'[.!?]+', text)),
            "word_count": len(text.split()),
            "is_short_sentence": len(text.split()) < 8,
            "is_long_sentence": len(text.split()) > 20,
            "starts_with_capital": text[0].isupper() if text else False,
        }
        
        # Detect dramatic moments
        dramatic_words = ['suddenly', 'immediately', 'finally', 'never', 'always', 'death', 'love', 'hate', 'fear']
        features['has_dramatic_word'] = any(w in text.lower() for w in dramatic_words)
        
        return features
    
    def _calculate_pacing(self, text: str, primary: str, secondary: str, rhetoric: dict) -> dict:
        """Calculate sophisticated pacing based on emotion + rhetoric"""
        
        # Base speed by emotion
        emotion_speeds = {
            # High energy / fast
            "excitement": 1.15, "joy": 1.12, "anger": 1.15, "surprise": 1.13,
            # Medium-high
            "amusement": 1.10, "optimism": 1.08, "pride": 1.08,
            # Medium
            "neutral": 1.0, "approval": 1.0, "realization": 1.0, "curiosity": 1.02,
            # Medium-slow
            "confusion": 0.95, "nervousness": 0.95, "disappointment": 0.92,
            # Slow / contemplative
            "sadness": 0.85, "grief": 0.82, "remorse": 0.85,
            "love": 0.90, "admiration": 0.90, "caring": 0.88,
            # Very slow / dramatic
            "fear": 0.88, "disgust": 0.88, "disapproval": 0.88,
        }
        
        speed = emotion_speeds.get(primary, 1.0)
        
        # Adjust for rhetoric
        notes = []
        
        if rhetoric['has_question']:
            speed *= 0.95  # Slower for questions
            notes.append("Question detected: slower, inquisitive")
        
        if rhetoric['has_exclamation'] and primary not in ['anger', 'excitement']:
            speed *= 1.05  # Speed up for exclamations (unless already high)
            notes.append("Exclamation: emphatic delivery")
        
        if rhetoric['has_ellipsis']:
            speed *= 0.90  # Slower for dramatic pauses
            notes.append("Ellipsis: trailing thought, slower")
        
        if rhetoric['is_short_sentence']:
            if primary in ['fear', 'surprise', 'anger']:
                speed *= 1.08  # Staccato for intense short sentences
                notes.append("Short sentence + intense emotion: staccato")
            else:
                speed *= 0.95
                notes.append("Short sentence: measured")
        
        if rhetoric['is_long_sentence']:
            if primary in ['sadness', 'grief', 'love']:
                notes.append("Long sentence + tender emotion: flowing, gentle")
            else:
                speed *= 0.95  # Slower to track complex thoughts
                notes.append("Long sentence: deliberate pacing")
        
        if rhetoric['has_dialogue']:
            notes.append("Dialogue: character voice")
        
        # Clamp speed
        speed = max(0.82, min(1.18, speed))
        
        # Determine energy
        high_energy = ['excitement', 'joy', 'anger', 'surprise', 'amusement', 'pride']
        low_energy = ['sadness', 'grief', 'remorse', 'fear', 'disgust', 'nervousness']
        
        if primary in high_energy:
            energy = "high"
        elif primary in low_energy:
            energy = "low"
        else:
            energy = "neutral"
        
        return {
            'speed': round(speed, 2),
            'energy': energy,
            'notes': notes
        }
    
    def _apply_narration_markup(self, text: str, emotion: str, rhetoric: dict, pacing: dict) -> str:
        """Apply sophisticated SML markup for narration"""
        import re
        
        modified = text
        
        # Emotion-specific markup
        emotion_markup = {
            "grief": {
                "end_pause": " [pause:2.0]",
                "comma_pause": " [pause:1.0]",
                "tone": "mournful"
            },
            "sadness": {
                "end_pause": " [pause:1.5]",
                "comma_pause": " [pause:0.8]",
                "tone": "melancholy"
            },
            "fear": {
                "end_pause": " [pause:0.6]",
                "comma_pause": " [pause:0.4]",
                "tone": "tense"
            },
            "excitement": {
                "end_pause": " [pause:0.4]",
                "comma_pause": " [pause:0.2]",
                "tone": "energetic"
            },
            "anger": {
                "end_pause": " [pause:0.5]",
                "comma_pause": " ",  # Remove pauses for staccato
                "tone": "sharp"
            },
            "love": {
                "end_pause": " [pause:1.2]",
                "comma_pause": " [pause:0.6]",
                "tone": "tender"
            },
            "surprise": {
                "end_pause": " [pause:0.8]",
                "comma_pause": " [pause:0.3]",
                "tone": "startled"
            },
            "neutral": {
                "end_pause": " [break]",
                "comma_pause": " [pause:0.5]",
                "tone": "even"
            }
        }
        
        markup = emotion_markup.get(emotion, emotion_markup["neutral"])
        
        # Apply sentence-ending pauses
        if emotion in ["grief", "sadness"]:
            modified = re.sub(r'\.+\s*$', f"...{markup['end_pause']}", modified)
            modified = re.sub(r'([.!?])(\s+)(?=[A-Z])', f"\\1{markup['end_pause']}\\2", modified)
        elif emotion == "anger":
            modified = re.sub(r'\.', "!", modified)
            modified = re.sub(r'([!])(\s+)(?=[A-Z])', f"\\1{markup['end_pause']}\\2", modified)
        else:
            modified = re.sub(r'([.!?])(\s+)(?=[A-Z])', f"\\1{markup['end_pause']}\\2", modified)
        
        # Apply comma pauses (unless anger - staccato)
        if emotion != "anger":
            modified = modified.replace(",", markup["comma_pause"])
        else:
            modified = modified.replace(",", " ")  # No pause for anger
        
        # Handle ellipses specially
        if "..." in modified:
            if emotion in ["grief", "sadness", "fear"]:
                modified = modified.replace("...", f"...{markup['end_pause']}")
            else:
                modified = modified.replace("...", f"... [pause:0.8]")
        
        # Handle em-dashes for interruptions
        if "—" in modified:
            modified = modified.replace("—", f" [pause:0.6]—[pause:0.4]")
        
        return modified

@app.function(image=image)
@modal.fastapi_endpoint(method="GET")
def health():
    return {"status": "ok", "model": "go-emotions-28", "quality": "audiobook"}
