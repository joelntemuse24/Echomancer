"""
Batch Emotion Director - Analyze full text, return tagged sentences
One API call, sentence-level nuance
"""

import modal

image = (
    modal.Image.debian_slim(python_version="3.10")
    .pip_install("transformers", "torch", "fastapi", "numpy")
)

app = modal.App("emotion-director-batch", image=image)

def split_into_sentences(text: str) -> list:
    """Split text into sentences, preserving punctuation"""
    import re
    # Match sentence endings followed by space or end of string
    sentence_endings = r'(?<=[.!?])\s+|\n\n+'
    sentences = re.split(sentence_endings, text.strip())
    return [s.strip() for s in sentences if s.strip()]

@app.cls(
    gpu="T4",
    scaledown_window=300,
)
class BatchEmotionDirector:
    @modal.enter()
    def load_model(self):
        from transformers import pipeline
        
        print("Loading Go-Emotions model...")
        self.classifier = pipeline(
            "text-classification",
            model="SamLowe/roberta-base-go_emotions",
            top_k=None,
            device=-1
        )
        
        self.sentiment = pipeline(
            "sentiment-analysis",
            model="distilbert-base-uncased-finetuned-sst-2-english",
            device=-1
        )
        print("Models ready!")
    
    @modal.fastapi_endpoint(method="POST")
    def analyze_batch(self, request: dict):
        """
        Analyze full text, return sentence-by-sentence with SML tags
        One API call = full analysis
        """
        text = request.get("text", "").strip()
        if not text:
            return {"error": "text required"}
        
        try:
            sentences = split_into_sentences(text)
            if not sentences:
                return {"tagged_text": text, "speed": 1.0, "energy": "neutral"}
            
            analyzed = []
            
            for sentence in sentences:
                # Get emotion
                emotions = self.classifier(sentence[:512])[0]
                emotions = sorted(emotions, key=lambda x: x['score'], reverse=True)
                primary = emotions[0]['label']
                
                # Get sentiment for sarcasm detection
                sentiment = self.sentiment(sentence[:512])[0]
                
                # Detect nuanced registers
                nuanced = self._detect_nuance(sentence, primary, sentiment)
                
                # Calculate pacing
                pacing = self._get_pacing(sentence, nuanced or primary)
                
                analyzed.append({
                    'text': sentence,
                    'emotion': nuanced or primary,
                    'confidence': emotions[0]['score'],
                    'speed': pacing['speed'],
                    'energy': pacing['energy'],
                    'pause_after': pacing['pause']
                })
            
            # Build tagged text with F5-TTS compatible SML tags
            # Format: [emotion:xxx speed:X energy:Y] text [pause:N]
            tagged_parts = []
            for i, item in enumerate(analyzed):
                # Add emotion tag with speed and energy at start of sentence
                tag = f"[emotion:{item['emotion']} speed:{item['speed']} energy:{item['energy']}]"
                tagged = f"{tag} {item['text']}"
                
                # Add pause tag at end (except last sentence)
                if i < len(analyzed) - 1:
                    tagged += f" [pause:{item['pause_after']}]"
                
                tagged_parts.append(tagged)
            
            # Calculate overall stats
            avg_speed = sum(a['speed'] for a in analyzed) / len(analyzed)
            energies = {}
            for a in analyzed:
                energies[a['energy']] = energies.get(a['energy'], 0) + 1
            dominant_energy = max(energies, key=energies.get)
            
            return {
                'tagged_text': ' '.join(tagged_parts),
                'speed': round(avg_speed, 2),
                'energy': dominant_energy,
                'sentence_count': len(analyzed),
                'breakdown': [
                    {
                        'text': a['text'][:50] + '...' if len(a['text']) > 50 else a['text'],
                        'emotion': a['emotion'],
                        'speed': a['speed']
                    }
                    for a in analyzed
                ]
            }
            
        except Exception as e:
            import traceback
            return {
                'tagged_text': text,
                'speed': 1.0,
                'energy': 'neutral',
                'error': str(e),
                'traceback': traceback.format_exc()
            }
    
    def _detect_nuance(self, text: str, primary: str, sentiment: dict) -> str | None:
        """Detect sarcasm, irony, etc. Return nuanced emotion or None"""
        text_lower = text.lower()
        
        # Sarcasm detection
        positive_words = ['great', 'wonderful', 'fantastic', 'love', 'perfect', 'amazing']
        negative_words = ['hate', 'terrible', 'awful', 'worst', 'horrible']
        
        has_positive = any(w in text_lower for w in positive_words)
        has_negative = any(w in text_lower for w in negative_words)
        
        # Positive words + negative emotion = sarcasm
        if (has_positive and primary in ['sadness', 'anger', 'disgust']) or \
           (has_negative and primary in ['joy', 'amusement']):
            return 'sarcasm'
        
        # Dry wit: understatement + amusement
        understatements = ['somewhat', 'rather', 'quite', 'a bit', 'slightly']
        if any(w in text_lower for w in understatements) and primary == 'amusement':
            return 'dry_wit'
        
        # Melancholy: sadness + nostalgia
        nostalgic = ['remember', 'used to', 'once', 'before', 'long ago']
        if primary == 'sadness' and any(w in text_lower for w in nostalgic):
            return 'melancholy'
        
        # Resignation: acceptance words
        resignation = ['i suppose', 'i guess', 'no point', 'doesnt matter', 'whatever']
        if any(p in text_lower for p in resignation):
            return 'resignation'
        
        # Longing: desire + distance
        longing = ['wish', 'if only', 'yearn', 'ache', 'miss']
        if primary in ['desire', 'sadness', 'love'] and any(w in text_lower for w in longing):
            return 'longing'
        
        return None
    
    def _get_pacing(self, text: str, emotion: str) -> dict:
        """Get speed and pause for emotion"""
        emotion_pacing = {
            'sarcasm': {'speed': 1.0, 'energy': 'high', 'pause': 0.3},
            'dry_wit': {'speed': 1.05, 'energy': 'low', 'pause': 0.5},
            'melancholy': {'speed': 0.82, 'energy': 'low', 'pause': 1.8},
            'resignation': {'speed': 0.90, 'energy': 'low', 'pause': 1.2},
            'longing': {'speed': 0.85, 'energy': 'low', 'pause': 1.5},
            'grief': {'speed': 0.82, 'energy': 'low', 'pause': 2.0},
            'sadness': {'speed': 0.85, 'energy': 'low', 'pause': 1.5},
            'love': {'speed': 0.90, 'energy': 'low', 'pause': 1.2},
            'anger': {'speed': 1.15, 'energy': 'high', 'pause': 0.4},
            'excitement': {'speed': 1.15, 'energy': 'high', 'pause': 0.3},
            'fear': {'speed': 0.88, 'energy': 'high', 'pause': 0.6},
            'joy': {'speed': 1.10, 'energy': 'high', 'pause': 0.4},
            'neutral': {'speed': 1.0, 'energy': 'neutral', 'pause': 0.8},
        }
        
        return emotion_pacing.get(emotion, emotion_pacing['neutral'])

@app.function(image=image)
@modal.fastapi_endpoint(method="GET")
def health():
    return {"status": "ok", "model": "batch-emotion-director", "mode": "sentence_level"}
