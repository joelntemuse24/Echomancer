"""
Professional Audiobook Emotion Director v3
Detects: 28 emotions + Irony, Sarcasm, Dry Wit, Melancholy, Resignation, Longing
Uses sentiment incongruity detection and linguistic pattern analysis
"""

import modal

image = (
    modal.Image.debian_slim(python_version="3.10")
    .pip_install("transformers", "torch", "fastapi", "numpy", "scipy")
)

app = modal.App("emotion-director-v3", image=image)

@app.cls(
    gpu="T4",
    scaledown_window=300,
)
class EmotionDirectorV3:
    @modal.enter()
    def load_model(self):
        """Load Go-Emotions + auxiliary models for nuanced detection"""
        from transformers import pipeline
        import numpy as np
        self.np = np
        
        print("Loading Go-Emotions model...")
        self.classifier = pipeline(
            "text-classification",
            model="SamLowe/roberta-base-go_emotions",
            top_k=None,
            device=-1
        )
        
        # Sentiment analyzer for incongruity detection
        print("Loading sentiment analyzer...")
        self.sentiment = pipeline(
            "sentiment-analysis",
            model="distilbert-base-uncased-finetuned-sst-2-english",
            device=-1
        )
        
        print("Models loaded! Detecting irony, sarcasm, and nuanced emotions...")
    
    @modal.fastapi_endpoint(method="POST")
    def analyze(self, request: dict):
        """Advanced emotional and rhetorical analysis with nuanced registers"""
        text = request.get("text", "").strip()
        if not text:
            return {"error": "text required"}
        
        try:
            # Get base emotions
            results = self.classifier(text[:512])[0]
            emotions = sorted(results, key=lambda x: x['score'], reverse=True)
            
            # Get sentiment for incongruity detection
            sentiment = self.sentiment(text[:512])[0]
            
            # Detect nuanced registers
            nuanced = self._detect_nuanced_registers(text, emotions, sentiment)
            
            # Analyze rhetorical features
            rhetorical = self._analyze_rhetoric(text)
            
            # Determine final emotional profile
            profile = self._calculate_emotional_profile(
                text, emotions, nuanced, rhetorical, sentiment
            )
            
            # Apply sophisticated narration markup
            modified_text = self._apply_narration_markup(
                text, profile, rhetorical
            )
            
            return {
                "modified_text": modified_text,
                "speed": profile['speed'],
                "energy": profile['energy'],
                "primary_emotion": profile['primary'],
                "secondary_emotion": profile['secondary'],
                "nuanced_registers": nuanced,
                "confidence": round(emotions[0]['score'], 3),
                "all_emotions": {e['label']: round(e['score'], 3) for e in emotions[:5]},
                "sentiment": sentiment,
                "rhetorical_features": rhetorical,
                "pacing_notes": profile['notes'],
                "performance_direction": profile['direction']
            }
            
        except Exception as e:
            import traceback
            return {
                "modified_text": text,
                "speed": 1.0,
                "energy": "neutral",
                "primary_emotion": "neutral",
                "error": str(e),
                "traceback": traceback.format_exc()
            }
    
    def _detect_nuanced_registers(self, text: str, emotions: list, sentiment: dict) -> dict:
        """Detect sarcasm, irony, dry wit, and other nuanced registers"""
        import re
        
        text_lower = text.lower()
        words = text_lower.split()
        
        # Get primary detected emotion vs sentiment
        primary_emotion = emotions[0]['label']
        sentiment_label = sentiment['label']
        sentiment_score = sentiment['score']
        
        nuanced = {
            "sarcasm": {"detected": False, "confidence": 0.0, "type": None},
            "irony": {"detected": False, "confidence": 0.0},
            "dry_wit": {"detected": False, "confidence": 0.0},
            "melancholy": {"detected": False, "confidence": 0.0},
            "resignation": {"detected": False, "confidence": 0.0},
            "longing": {"detected": False, "confidence": 0.0},
            "bittersweet": {"detected": False, "confidence": 0.0},
            "wistful": {"detected": False, "confidence": 0.0},
        }
        
        # SARCASM DETECTION
        sarcasm_markers = 0
        
        # 1. Incongruity: Positive words with negative emotion or vice versa
        positive_words = ['great', 'wonderful', 'fantastic', 'love', 'perfect', 'amazing', 'awesome']
        negative_words = ['hate', 'terrible', 'awful', 'worst', 'horrible', 'disgusting']
        
        has_positive = any(w in text_lower for w in positive_words)
        has_negative = any(w in text_lower for w in negative_words)
        
        # Sarcasm: Positive words but detected sadness/anger OR negative words but detected joy
        if (has_positive and primary_emotion in ['sadness', 'anger', 'disgust', 'disappointment']) or \
           (has_negative and primary_emotion in ['joy', 'amusement', 'excitement']):
            sarcasm_markers += 2
        
        # 2. Excessive positivity (overstatement)
        extreme_pos = ['absolutely', 'totally', 'completely', 'literally', 'definitely']
        if sum(1 for w in extreme_pos if w in text_lower) >= 2:
            sarcasm_markers += 1
        
        # 3. Rhetorical questions with incongruity
        if '?' in text and (has_positive != (sentiment_label == 'POSITIVE')):
            sarcasm_markers += 1
        
        # 4. Quotation marks suggesting non-literal meaning
        if '"' in text or '"' in text or "'" in text:
            sarcasm_markers += 0.5
        
        # 5. Exclamation on supposedly sad/negative content
        if '!' in text and primary_emotion in ['sadness', 'disappointment', 'grief']:
            sarcasm_markers += 1
        
        if sarcasm_markers >= 2:
            nuanced['sarcasm']['detected'] = True
            nuanced['sarcasm']['confidence'] = min(sarcasm_markers / 4, 1.0)
            nuanced['sarcasm']['type'] = 'verbal_irony' if sarcasm_markers >= 3 else 'mild'
        
        # IRONY DETECTION (situational irony - different from sarcasm)
        irony_markers = 0
        
        # Contrast between expectation and reality
        contrast_words = ['yet', 'but', 'however', 'although', 'though', 'still', 'nevertheless']
        if any(w in words for w in contrast_words):
            irony_markers += 1
        
        # Dramatic timing words
        timing_words = ['suddenly', 'just then', 'at that moment', 'finally', 'inevitably']
        if any(w in text_lower for w in timing_words):
            irony_markers += 0.5
        
        if irony_markers >= 1.5 and not nuanced['sarcasm']['detected']:
            nuanced['irony']['detected'] = True
            nuanced['irony']['confidence'] = min(irony_markers / 2, 1.0)
        
        # DRY WIT / DEADPAN HUMOR
        wit_markers = 0
        
        # Understatement
        understatements = ['somewhat', 'rather', 'quite', 'a bit', 'slightly', 'fairly']
        if any(w in text_lower for w in understatements):
            wit_markers += 1
        
        # Absurd contrast (high emotion score but neutral words)
        if emotions[0]['score'] > 0.8 and primary_emotion in ['amusement', 'joy']:
            neutral_context = all(w not in text_lower for w in ['funny', 'laugh', 'haha', 'lol', 'joke'])
            if neutral_context:
                wit_markers += 1.5
        
        # Flat delivery markers (minimal punctuation)
        if text.count('!') == 0 and emotions[0]['score'] > 0.7:
            wit_markers += 0.5
        
        if wit_markers >= 2 and primary_emotion in ['amusement', 'neutral', 'approval']:
            nuanced['dry_wit']['detected'] = True
            nuanced['dry_wit']['confidence'] = min(wit_markers / 3, 1.0)
        
        # MELANCHOLY (deeper than sadness - nostalgic, reflective)
        if primary_emotion == 'sadness' or primary_emotion == 'grief':
            nostalgic_words = ['remember', 'used to', 'once', 'before', 'long ago', 'childhood', 'past']
            time_words = ['time', 'years', 'ago', 'passed', 'faded', 'gone', 'lost']
            
            nostalgic_score = sum(1 for w in nostalgic_words if w in text_lower)
            time_score = sum(1 for w in time_words if w in text_lower)
            
            if nostalgic_score >= 1 or time_score >= 2:
                nuanced['melancholy']['detected'] = True
                nuanced['melancholy']['confidence'] = min((nostalgic_score + time_score) / 3, 1.0)
        
        # RESIGNATION (acceptance without happiness)
        if primary_emotion in ['sadness', 'neutral', 'disappointment']:
            resignation_words = ['suppose', 'guess', 'just', 'simply', 'nothing', 'point', 'anymore', 'anyway']
            resignation_phrases = ['i suppose', 'i guess', 'no point', 'doesnt matter', 'whatever happens']
            
            res_score = sum(1 for w in resignation_words if w in text_lower)
            res_phrases = sum(1 for p in resignation_phrases if p in text_lower)
            
            if res_score >= 2 or res_phrases >= 1:
                nuanced['resignation']['detected'] = True
                nuanced['resignation']['confidence'] = min((res_score + res_phrases * 2) / 4, 1.0)
        
        # LONGING (desire for something unattainable)
        if primary_emotion in ['desire', 'sadness', 'love']:
            longing_words = ['wish', 'if only', 'could have', 'would that', 'yearn', 'ache', 'miss']
            distance_words = ['far', 'away', 'distant', 'unreachable', 'gone', 'forever']
            
            long_score = sum(1 for w in longing_words if w in text_lower)
            dist_score = sum(1 for w in distance_words if w in text_lower)
            
            if long_score >= 1:
                nuanced['longing']['detected'] = True
                nuanced['longing']['confidence'] = min((long_score + dist_score) / 3, 1.0)
        
        # BITTERSWEET (mixed joy and sadness)
        top_emotions = [e['label'] for e in emotions[:3]]
        joy_sad_mix = any(e in top_emotions for e in ['joy', 'amusement', 'excitement', 'love']) and \
                      any(e in top_emotions for e in ['sadness', 'grief', 'disappointment'])
        
        if joy_sad_mix:
            nuanced['bittersweet']['detected'] = True
            nuanced['bittersweet']['confidence'] = 0.7
        
        # WISTFUL (gentle, pensive longing)
        if nuanced['melancholy']['detected'] and nuanced['longing']['detected']:
            if emotions[0]['score'] < 0.8:  # Not intense emotion
                nuanced['wistful']['detected'] = True
                nuanced['wistful']['confidence'] = (nuanced['melancholy']['confidence'] + 
                                                    nuanced['longing']['confidence']) / 2
        
        return nuanced
    
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
        
        dramatic_words = ['suddenly', 'immediately', 'finally', 'never', 'always', 'death', 'love', 'hate', 'fear']
        features['has_dramatic_word'] = any(w in text.lower() for w in dramatic_words)
        
        return features
    
    def _calculate_emotional_profile(self, text: str, emotions: list, 
                                     nuanced: dict, rhetorical: dict, 
                                     sentiment: dict) -> dict:
        """Calculate final emotional profile with nuanced registers"""
        
        primary = emotions[0]['label']
        secondary = emotions[1]['label'] if len(emotions) > 1 else None
        
        # Override with nuanced registers if detected with high confidence
        direction = []
        notes = []
        
        # Check for nuanced overrides
        if nuanced['sarcasm']['detected'] and nuanced['sarcasm']['confidence'] > 0.6:
            primary = "sarcasm"
            direction.append("Deliver with exaggerated sincerity that slightly overshoots")
            direction.append("Pause before the punchline, then slightly faster on the reveal")
            notes.append(f"Sarcasm detected ({nuanced['sarcasm']['type']})")
        
        elif nuanced['dry_wit']['detected'] and nuanced['dry_wit']['confidence'] > 0.6:
            primary = "dry_wit"
            direction.append("Deadpan delivery - no emotional inflection")
            direction.append("Let the humor land through contrast with flat tone")
            notes.append("Dry wit - flat delivery")
        
        elif nuanced['melancholy']['detected'] and nuanced['melancholy']['confidence'] > 0.5:
            primary = "melancholy"
            direction.append("Warm, nostalgic tone with longer pauses between phrases")
            direction.append("Slightly breathy quality, as if remembering")
            notes.append("Melancholy - nostalgic reflection")
        
        elif nuanced['resignation']['detected'] and nuanced['resignation']['confidence'] > 0.5:
            primary = "resignation"
            direction.append("Flat affect, trailing off at sentence ends")
            direction.append("Slight pause before accepting words ('suppose', 'guess')")
            notes.append("Resignation - acceptance without resolution")
        
        elif nuanced['longing']['detected'] and nuanced['longing']['confidence'] > 0.5:
            primary = "longing"
            direction.append("Soft, yearning quality")
            direction.append("Slight hesitation before words of desire")
            notes.append("Longing - unfulfilled desire")
        
        elif nuanced['bittersweet']['detected']:
            primary = "bittersweet"
            direction.append("Warm smile in voice that occasionally cracks")
            direction.append("Joy with underlying sadness - let both show")
            notes.append("Bittersweet - mixed emotions")
        
        elif nuanced['wistful']['detected']:
            primary = "wistful"
            direction.append("Gentle, pensive, slightly distant")
            direction.append("As if looking at something just out of reach")
            notes.append("Wistful - gentle longing")
        
        elif nuanced['irony']['detected']:
            direction.append("Dramatic irony - let the audience hear what character doesn't")
            notes.append("Situational irony present")
        
        # Base speeds
        base_speeds = {
            "sarcasm": 1.0, "dry_wit": 1.05, "melancholy": 0.82,
            "resignation": 0.90, "longing": 0.85, "bittersweet": 0.88,
            "wistful": 0.87, "excitement": 1.15, "joy": 1.12,
            "anger": 1.15, "surprise": 1.13, "amusement": 1.10,
            "optimism": 1.08, "pride": 1.08, "neutral": 1.0,
            "approval": 1.0, "realization": 1.0, "curiosity": 1.02,
            "confusion": 0.95, "nervousness": 0.95, "disappointment": 0.92,
            "sadness": 0.85, "grief": 0.82, "remorse": 0.85,
            "love": 0.90, "admiration": 0.90, "caring": 0.88,
            "fear": 0.88, "disgust": 0.88, "disapproval": 0.88,
        }
        
        speed = base_speeds.get(primary, 1.0)
        
        # Adjust for rhetoric
        if rhetorical['has_ellipsis']:
            speed *= 0.92
            notes.append("Ellipsis: slower, trailing")
        
        if rhetorical['is_short_sentence'] and primary not in ['sarcasm', 'dry_wit']:
            if primary in ['fear', 'surprise', 'anger']:
                speed *= 1.08
                notes.append("Staccato delivery")
            else:
                speed *= 0.95
        
        if rhetorical['is_long_sentence'] and primary in ['melancholy', 'longing', 'wistful']:
            notes.append("Flowing, unhurried")
        
        # Energy levels
        high_energy = ['excitement', 'joy', 'anger', 'surprise', 'amusement', 'pride', 'sarcasm']
        low_energy = ['sadness', 'grief', 'remorse', 'fear', 'disgust', 'melancholy', 
                      'resignation', 'longing', 'wistful', 'bittersweet', 'dry_wit']
        
        if primary in high_energy:
            energy = "high"
        elif primary in low_energy:
            energy = "low"
        else:
            energy = "neutral"
        
        speed = max(0.80, min(1.20, speed))
        
        return {
            'primary': primary,
            'secondary': secondary,
            'speed': round(speed, 2),
            'energy': energy,
            'notes': notes,
            'direction': direction
        }
    
    def _apply_narration_markup(self, text: str, profile: dict, rhetorical: dict) -> str:
        """Apply sophisticated SML markup for nuanced narration"""
        import re
        
        emotion = profile['primary']
        modified = text
        
        # Nuanced markup configurations
        markup_configs = {
            "sarcasm": {
                "pattern": r'([.!?])(\s+)(?=[A-Z])',
                "end_replacement": r'\1 [pause:0.3]\2',
                "comma_replacement": " [pause:0.2]",
                "tone": "exaggerated_sincerity"
            },
            "dry_wit": {
                "pattern": r'([.!?])(\s+)(?=[A-Z])',
                "end_replacement": r'\1 [pause:0.5]\2',
                "comma_replacement": " [pause:0.3]",
                "tone": "deadpan"
            },
            "melancholy": {
                "pattern": r'([.!?])(\s+)(?=[A-Z])',
                "end_replacement": r'\1 [pause:1.8]\2',
                "comma_replacement": " [pause:1.0]",
                "tone": "nostalgic_warm"
            },
            "resignation": {
                "pattern": r'([.!?])(\s+)(?=[A-Z])',
                "end_replacement": r'\1 [pause:1.2]\2',
                "comma_replacement": " [pause:0.6]",
                "tone": "flat_trailing"
            },
            "longing": {
                "pattern": r'([.!?])(\s+)(?=[A-Z])',
                "end_replacement": r'\1 [pause:1.5]\2',
                "comma_replacement": " [pause:0.8]",
                "tone": "yearning"
            },
            "bittersweet": {
                "pattern": r'([.!?])(\s+)(?=[A-Z])',
                "end_replacement": r'\1 [pause:1.3]\2',
                "comma_replacement": " [pause:0.7]",
                "tone": "warm_cracking"
            },
            "wistful": {
                "pattern": r'([.!?])(\s+)(?=[A-Z])',
                "end_replacement": r'\1 [pause:1.4]\2',
                "comma_replacement": " [pause:0.9]",
                "tone": "gentle_distant"
            },
            "grief": {
                "end_pause": " [pause:2.0]",
                "comma_pause": " [pause:1.0]"
            },
            "sadness": {
                "end_pause": " [pause:1.5]",
                "comma_pause": " [pause:0.8]"
            },
            "love": {
                "end_pause": " [pause:1.2]",
                "comma_pause": " [pause:0.6]"
            },
            "neutral": {
                "end_pause": " [break]",
                "comma_pause": " [pause:0.5]"
            }
        }
        
        config = markup_configs.get(emotion, markup_configs["neutral"])
        
        # Apply emotion-specific markup
        if emotion in ["sarcasm", "dry_wit", "melancholy", "resignation", "longing", "bittersweet", "wistful"]:
            modified = re.sub(config["pattern"], config["end_replacement"], modified)
            modified = modified.replace(",", config["comma_replacement"])
        elif emotion in ["grief", "sadness", "love"]:
            modified = re.sub(r'([.!?])(\s+)(?=[A-Z])', f"\\1{config['end_pause']}\\2", modified)
            modified = modified.replace(",", config["comma_pause"])
        else:
            modified = re.sub(r'([.!?])(\s+)(?=[A-Z])', f"\\1{config.get('end_pause', ' [break]')}\\2", modified)
            modified = modified.replace(",", config.get("comma_pause", " [pause:0.5]"))
        
        # Handle ellipses with nuance
        if "..." in modified:
            if emotion in ["melancholy", "wistful", "longing"]:
                modified = modified.replace("...", f"... [pause:1.5]")
            elif emotion in ["resignation", "sadness", "grief"]:
                modified = modified.replace("...", f"... [pause:2.0]")
            elif emotion == "sarcasm":
                modified = modified.replace("...", f"... [pause:0.4]")
            else:
                modified = modified.replace("...", f"... [pause:0.8]")
        
        # Handle em-dashes
        if "—" in modified:
            if emotion in ["sarcasm", "dry_wit"]:
                modified = modified.replace("—", " [pause:0.3]—[pause:0.2]")
            else:
                modified = modified.replace("—", " [pause:0.6]—[pause:0.4]")
        
        return modified

@app.function(image=image)
@modal.fastapi_endpoint(method="GET")
def health():
    return {"status": "ok", "model": "emotion-director-v3", 
            "features": ["28_emotions", "sarcasm", "irony", "dry_wit", 
                        "melancholy", "resignation", "longing", "bittersweet", "wistful"]}
