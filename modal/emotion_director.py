"""
Emotion Director - Small transformer for nuanced emotions
DistilBERT-based: 66MB, loads in ~10-15s on cold start
"""

import modal

image = (
    modal.Image.debian_slim(python_version="3.10")
    .pip_install("transformers", "torch", "fastapi")
)

app = modal.App("emotion-director", image=image)

@app.cls(
    gpu="T4",
    scaledown_window=300,
)
class EmotionDirector:
    @modal.enter()
    def load_model(self):
        """Load small emotion model (~66MB)"""
        from transformers import pipeline
        
        print("Downloading emotion model (66MB)...")
        # j-hartmann/emotion-english-distilroberta-base - 6 emotions
        self.classifier = pipeline(
            "text-classification", 
            model="j-hartmann/emotion-english-distilroberta-base",
            return_all_scores=True,
            device=-1  # CPU to avoid CUDA issues
        )
        
        print("Emotion model ready!")
    
    @modal.fastapi_endpoint(method="POST")
    def analyze(self, request: dict):
        """Analyze emotion and return pacing instructions"""
        text = request.get("text", "").strip()
        if not text:
            return {"error": "text required"}
        
        try:
            # Get emotion scores
            results = self.classifier(text[:512])  # Truncate if too long
            
            # Map emotions to speed/energy/punctuation
            emotion_map = {
                "anger":     {"speed": 1.15, "energy": "high",   "pause": 0.3},
                "disgust":   {"speed": 0.95, "energy": "low",    "pause": 0.8},
                "fear":      {"speed": 1.10, "energy": "high",   "pause": 0.4},
                "joy":       {"speed": 1.10, "energy": "high",   "pause": 0.3},
                "neutral":   {"speed": 1.00, "energy": "neutral","pause": 0.5},
                "sadness":   {"speed": 0.85, "energy": "low",    "pause": 1.0},
                "surprise":  {"speed": 1.15, "energy": "high",   "pause": 0.4},
            }
            
            # Get dominant emotion
            top_emotion = max(results[0], key=lambda x: x['score'])
            emotion = top_emotion['label'].lower()
            confidence = top_emotion['score']
            
            # Get settings
            settings = emotion_map.get(emotion, emotion_map["neutral"])
            
            # Simple text modification based on emotion
            modified = text
            if emotion == "sadness":
                modified = modified.replace(".", "... [pause:1.5]")
            elif emotion == "anger":
                modified = modified.replace(".", "! [pause:0.3]")
            elif emotion == "fear":
                modified = modified.replace(",", " [pause:0.4]")
            elif emotion == "joy":
                modified = modified.replace(".", "! [pause:0.5]")
            else:
                modified = modified.replace(".", ". [break]")
            
            return {
                "modified_text": modified,
                "speed": settings["speed"],
                "energy": settings["energy"],
                "emotion": emotion,
                "confidence": round(confidence, 3),
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

@app.function(image=image)
@modal.fastapi_endpoint(method="GET")
def health():
    return {"status": "ok", "model": "emotion-distilbert", "size": "66MB"}
