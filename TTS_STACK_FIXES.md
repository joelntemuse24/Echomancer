# TTS Stack Fixes: Implementation Guide

This document provides specific code changes to address the issues identified in the audit.

---

## Fix 1: Reduce Chunk Size (Critical)

### Problem
1000 chars exceeds F5-TTS's 30-second generation limit.

### Solution

```typescript
// src/lib/generate-audiobook-v2.ts
// Change line 92:
const sections = splitBySentences(text, 1000);

// To:
const sections = splitBySentences(text, 500); // 400-600 char range
```

### Add Chunk Overlap

```typescript
// Add to src/lib/generate-audiobook-v2.ts

interface TextSection {
  text: string;
  sentenceCount: number;
  overlapWithPrevious?: string; // For co-articulation
}

function splitBySentencesWithOverlap(
  text: string, 
  targetLength: number = 500,
  overlapChars: number = 75
): TextSection[] {
  const baseSections = splitBySentences(text, targetLength);
  
  const sections: TextSection[] = [];
  let previousEnd = "";
  
  for (let i = 0; i < baseSections.length; i++) {
    const section = baseSections[i];
    
    // Add overlap from previous section (except first)
    const textWithOverlap = i > 0 
      ? previousEnd + section.text
      : section.text;
    
    // Store end of this section for next overlap
    previousEnd = section.text.slice(-overlapChars);
    
    sections.push({
      ...section,
      text: textWithOverlap,
      overlapWithPrevious: i > 0 ? previousEnd : undefined
    });
  }
  
  return sections;
}
```

---

## Fix 2: Unify Loudness Target (Critical)

### Problem
Inconsistent loudness targets between server (-16 LUFS) and client (-23 LUFS).

### Solution

```python
# modal/f5_tts_server_fixed.py
# Line 330, change:
"-af", "loudnorm=I=-16:TP=-1.5:LRA=11",

# To:
"-af", "loudnorm=I=-23:TP=-2:LRA=7",  # EBU R128 broadcast standard
```

```typescript
// src/lib/generate-audiobook-v2.ts  
// Line 567 is already -23, so just verify consistency
// Ensure normalizeAudio function uses:
"loudnorm=I=-23:LRA=7:TP=-2"
```

---

## Fix 3: Add VAD to Voice Preprocessing (Critical)

### Problem
No VAD in F5-TTS server pipeline, leading to potential silence in reference audio.

### Solution

```python
# Add to modal/f5_tts_server_fixed.py

def _process_voice_sample(self, audio_bytes, temp_files):
    """Process voice sample with VAD-based trimming."""
    import librosa
    import torch
    from silero_vad import load_silero_vad, get_speech_timestamps
    
    # Save raw audio
    raw_tmp = tempfile.NamedTemporaryFile(suffix=".audio", delete=False)
    raw_tmp.write(audio_bytes)
    raw_tmp.close()
    temp_files.append(raw_tmp.name)
    
    # Convert to WAV for VAD analysis
    wav_path = raw_tmp.name.replace(".audio", "_24k.wav")
    subprocess.run([
        "ffmpeg", "-y", "-i", raw_tmp.name,
        "-ar", "24000", "-ac", "1",
        wav_path
    ], capture_output=True, check=True)
    temp_files.append(wav_path)
    
    # Load for VAD analysis
    wav, sr = torchaudio.load(wav_path)
    
    # Resample to 16kHz for Silero VAD
    if sr != 16000:
        resampler = torchaudio.transforms.Resample(sr, 16000)
        wav_16k = resampler(wav)
    else:
        wav_16k = wav
    
    # Run VAD
    wav_16k = wav_16k.mean(dim=0)  # mono
    speech_timestamps = get_speech_timestamps(wav_16k, self.vad_model, return_seconds=True)
    
    if not speech_timestamps:
        raise ValueError("No speech detected in voice sample")
    
    # Find best continuous 10-12s segment
    best_segment = self._find_best_segment(speech_timestamps, 12)
    
    # Extract and normalize
    final_path = raw_tmp.name.replace(".audio", "_final.wav")
    
    cmd = [
        "ffmpeg", "-y", "-i", wav_path,
        "-ss", str(best_segment['start']),
        "-t", str(best_segment['end'] - best_segment['start']),
        "-ar", "24000", "-ac", "1",
        "-af", "loudnorm=I=-23:TP=-2:LRA=7",  # EBU R128
        final_path
    ]
    
    subprocess.run(cmd, capture_output=True, check=True)
    temp_files.append(final_path)
    
    # Check duration
    y, sr = librosa.load(final_path, sr=None)
    duration = librosa.get_duration(y=y, sr=sr)
    
    if duration < 3:
        raise ValueError(f"Voice sample too short: {duration:.1f}s (min 3s)")
    
    print(f"Voice sample: {duration:.1f}s (extracted from speech segment)")
    
    return final_path, ""

def _find_best_segment(self, speech_timestamps, target_duration):
    """Find the best continuous speech segment of target duration."""
    # Merge overlapping timestamps
    merged = []
    for ts in speech_timestamps:
        if not merged or ts['start'] > merged[-1]['end']:
            merged.append(ts)
        else:
            merged[-1]['end'] = max(merged[-1]['end'], ts['end'])
    
    # Find segment with most speech content
    best_segment = None
    best_speech_ratio = 0
    
    for ts in merged:
        segment_duration = ts['end'] - ts['start']
        if segment_duration >= target_duration:
            # This segment is long enough, use it
            return {
                'start': ts['start'],
                'end': ts['start'] + target_duration
            }
    
    # If no single segment is long enough, use the longest one
    longest = max(merged, key=lambda x: x['end'] - x['start'])
    return {
        'start': longest['start'],
        'end': min(longest['end'], longest['start'] + 15)  # Cap at 15s
    }
```

---

## Fix 4: Fix Multi-Reference Implementation (Critical)

### Problem
Concatenating audio doesn't work - F5-TTS truncates to first 12s anyway.

### Solution: Pick Best Sample Instead

```typescript
// src/lib/generate-audiobook-v2.ts
// Replace prepareVoiceSamples function

async function prepareVoiceSamples(
  supabase: ReturnType<typeof getSupabase>,
  voiceStoragePaths: string[],
  videoId: string | null,
  startTime: number,
  endTime: number,
  jobId: string
): Promise<Buffer> {
  if (voiceStoragePaths.length === 0) {
    throw new Error("No voice samples provided");
  }

  const processedSamples: ProcessedSample[] = [];
  
  // Process each voice sample
  for (const storagePath of voiceStoragePaths) {
    try {
      console.log(`[Job ${jobId}] Processing voice sample: ${storagePath}`);
      
      const { data: voiceData, error } = await supabase.storage
        .from("audiobooks")
        .download(storagePath);

      if (error || !voiceData) {
        console.warn(`[Job ${jobId}] Failed to download voice ${storagePath}: ${error?.message}`);
        continue;
      }

      let voiceBuffer: Buffer = Buffer.from(await voiceData.arrayBuffer()) as Buffer;
      
      const clipDuration = endTime - startTime;
      if (clipDuration < 3) {
        console.warn(`[Job ${jobId}] Voice clip too short: ${clipDuration}s, skipping`);
        continue;
      }
      
      voiceBuffer = await clipAudioBuffer(voiceBuffer, startTime, endTime);
      voiceBuffer = await normalizeAudio(voiceBuffer);
      voiceBuffer = await trimSilence(voiceBuffer);
      
      // Call Audio Cleaner for vocal isolation
      const cleanerUrl = process.env.MODAL_AUDIO_CLEANER_URL;
      if (cleanerUrl) {
        try {
          const response = await fetch(cleanerUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
              audio_base64: voiceBuffer.toString("base64"),
            }),
            signal: AbortSignal.timeout(300_000),
          });
          
          if (response.ok) {
            const result = await response.json();
            if (result.audio_base64) {
              voiceBuffer = Buffer.from(result.audio_base64, "base64");
            }
          }
        } catch (err) {
          console.warn(`[Job ${jobId}] Audio cleaner failed, using preprocessed:`, err);
        }
      }
      
      // Calculate quality metrics
      const quality = await calculateQualityMetrics(voiceBuffer);
      
      processedSamples.push({ 
        buffer: voiceBuffer, 
        quality: quality.score, 
        duration: quality.duration,
        snr: quality.snr,
        pitchStability: quality.pitchStability
      });
      
    } catch (err) {
      console.warn(`[Job ${jobId}] Failed to process sample ${storagePath}:`, err);
    }
  }

  if (processedSamples.length === 0) {
    throw new Error("No valid voice samples could be processed");
  }

  // Sort by quality and pick the BEST single sample
  processedSamples.sort((a, b) => b.quality - a.quality);
  
  const bestSample = processedSamples[0];
  console.log(`[Job ${jobId}] Selected best sample: quality=${bestSample.quality.toFixed(2)}, SNR=${bestSample.snr.toFixed(1)}dB`);
  
  return bestSample.buffer;
}

// New function to calculate objective quality metrics
async function calculateQualityMetrics(buffer: Buffer): Promise<{
  score: number;
  duration: number;
  snr: number;
  pitchStability: number;
}> {
  // Use ffprobe to get audio stats
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const fs = await import("fs");
  const path = await import("path");
  const os = await import("os");
  
  const execAsync = promisify(exec);
  const tempDir = os.tmpdir();
  const inputPath = path.join(tempDir, `quality_${Date.now()}.wav`);
  
  try {
    fs.writeFileSync(inputPath, buffer);
    
    // Get duration and loudness stats
    const { stdout } = await execAsync(
      `ffprobe -i "${inputPath}" -af "loudnorm=print_format=json" -f null - 2>&1`
    );
    
    // Parse loudness stats
    const loudnessMatch = stdout.match(/\{\s*"input_i"[^}]+\}/);
    const inputLoudness = loudnessMatch ? 
      parseFloat(JSON.parse(loudnessMatch[0]).input_i) : -70;
    
    // Calculate SNR proxy (higher loudness = likely better SNR)
    const snr = Math.max(0, inputLoudness + 70); // Normalize to 0-70 range
    
    // Get duration
    const { stdout: durOut } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${inputPath}"`
    );
    const duration = parseFloat(durOut.trim()) || 0;
    
    // Quality score combines multiple factors
    let score = 1.0;
    
    // SNR contribution (0-0.4)
    score += (snr / 70) * 0.4;
    
    // Duration contribution - prefer 8-12s (0-0.3)
    const durationScore = duration >= 8 && duration <= 12 ? 0.3 : 
                         duration >= 5 ? 0.2 : 0.1;
    score += durationScore;
    
    // File size sanity check (0-0.3)
    const sizeMB = buffer.length / (1024 * 1024);
    if (sizeMB >= 0.1 && sizeMB <= 2) {
      score += 0.3;
    } else {
      score += 0.15;
    }
    
    return {
      score,
      duration,
      snr,
      pitchStability: 0.5 // Placeholder - would need pitch analysis
    };
    
  } finally {
    try { fs.unlinkSync(inputPath); } catch {}
  }
}
```

---

## Fix 5: Remove or Simplify LLM Director (High Priority)

### Option A: Remove Entirely (Recommended)

```typescript
// src/lib/generate-audiobook-v2.ts
// Replace callLlmDirector with simple heuristic

async function getProsodyParams(text: string): Promise<{ speed: number; pauseMultiplier: number }> {
  // Simple punctuation-based speed adjustment
  // No LLM needed, no external call, no latency
  
  let speed = 1.0;
  let pauseMultiplier = 1.0;
  
  // Count punctuation
  const questionMarks = (text.match(/\?/g) || []).length;
  const exclamations = (text.match(/!/g) || []).length;
  const commas = (text.match(/,/g) || []).length;
  const ellipses = (text.match(/\.{3,}/g) || []).length;
  
  // Adjust speed based on punctuation density
  const punctuationDensity = (questionMarks + exclamations + commas) / text.length;
  
  if (questionMarks > 0) {
    speed *= 0.95; // Slightly slower for questions
  }
  if (exclamations > 0) {
    speed *= 1.05; // Slightly faster for exclamations
  }
  if (ellipses > 0) {
    speed *= 0.90; // Slower for trailing thoughts
    pauseMultiplier = 1.5;
  }
  if (punctuationDensity > 0.1) {
    speed *= 0.95; // Slower for complex sentences
  }
  
  // Clamp to reasonable range
  speed = Math.max(0.85, Math.min(1.15, speed));
  
  return { speed, pauseMultiplier };
}
```

### Option B: Keep but Simplify

If you must keep the LLM Director, at least make it optional and add caching:

```typescript
// Add caching to avoid repeated analysis of same text
const emotionCache = new Map<string, { result: any; timestamp: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function callLlmDirector(text: string, jobId: string): Promise<{ modified_text: string; speed: number; energy: string }> {
  // Check cache first
  const cacheKey = text.slice(0, 100); // First 100 chars as key
  const cached = emotionCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log(`[Job ${jobId}] Using cached emotion analysis`);
    return cached.result;
  }
  
  const emotionUrl = process.env.MODAL_LLM_DIRECTOR_URL;
  
  // Skip if not configured
  if (!emotionUrl) {
    return { modified_text: text, speed: 1.0, energy: "neutral" };
  }
  
  // Add timeout and retry logic
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000); // 10s max
    
    const response = await fetch(emotionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      throw new Error(`Emotion API error: ${response.status}`);
    }

    const result = await response.json();
    
    const output = {
      modified_text: result?.modified_text || text,
      speed: result?.speed || 1.0,
      energy: result?.energy || "neutral"
    };
    
    // Cache result
    emotionCache.set(cacheKey, { result: output, timestamp: Date.now() });
    
    return output;
    
  } catch (err) {
    console.warn(`[Job ${jobId}] Emotion Director failed, using defaults:`, err);
    return { modified_text: text, speed: 1.0, energy: "neutral" };
  }
}
```

---

## Fix 6: Optimize Inference Parameters (High Priority)

### Add NFE Step Control

```python
# modal/f5_tts_server_fixed.py
# In the generate method, add nfe_steps parameter

@modal.fastapi_endpoint(method="POST")
def generate(self, request: dict):
    # ... existing code ...
    
    # Get NFE steps (default 32 for speed, max 64 for quality)
    nfe_steps = int(request.get("nfe_steps", 32))
    nfe_steps = max(16, min(64, nfe_steps))  # Clamp to valid range
    
    # ... existing code ...
    
    with self._lock:
        wav, sr, _ = self.tts.infer(
            ref_file=ref_path,
            ref_text=ref_text,
            gen_text=segment,
            speed=segment_speed,
            nfe_steps=nfe_steps,  # Add this
        )
```

### Remove Jitter (No Research Support)

```python
# modal/f5_tts_server_fixed.py
# Lines 165-170, remove jitter:

# REMOVE THIS:
# Inference-time jitter: Add micro-variations for naturalness
# jitter_amount = float(request.get("jitter", 0.03))
# speed_jitter = 1.0 + random.uniform(-jitter_amount, jitter_amount)
# actual_speed = requested_speed * 0.9 * speed_jitter

# USE THIS:
actual_speed = requested_speed * 0.9
```

---

## Fix 7: Drop 44kHz Upsampling (High Priority)

### Simplify Audio Output

```typescript
// src/lib/generate-audiobook-v2.ts
// In modalTTS function, change:

const payload = JSON.stringify({
  text,
  reference_audio_base64: voiceBase64,
  format: "mp3",
  speed: speed,
  // REMOVE: output_sample_rate: 44100,
  // REMOVE: jitter: 0.03,
});
```

```python
# modal/f5_tts_server_fixed.py
# In generate method, make upsampling optional and default off:

# Line 173, change:
output_sample_rate = int(request.get("output_sample_rate", 24000))  # Default to native

# To:
output_sample_rate = int(request.get("output_sample_rate", 24000))
if output_sample_rate != 24000:
    print(f"Warning: Upsampling from 24kHz to {output_sample_rate}Hz - no quality benefit for speech")
```

---

## Fix 8: Optimize Post-Processing Order (Medium Priority)

### Fix Audio Enhancer Order

```python
# modal/audio_enhancer.py
# The current order is correct (breaths -> processing)
# Just ensure it's called BEFORE upsampling

# In generate-audiobook-v2.ts, ensure enhancer is called 
# BEFORE any upsampling happens
```

### Fix Normalization in F5-TTS Server

```python
# modal/f5_tts_server_fixed.py
# Move normalization to end, after all processing

# In generate method:

# Concatenate all segments
full_audio = np.concatenate(audio_segments)

# Don't normalize here - do it at the end after all processing
# max_val = np.abs(full_audio).max()
# if max_val > 0:
#     full_audio = full_audio / max_val * 0.95

full_audio = full_audio.astype(np.float32)

# Encode to requested format
audio_bytes = self._encode_audio(
    full_audio, 
    sample_rate, 
    audio_format, 
    temp_files,
    target_sr=output_sample_rate
)

# Normalize in _encode_audio instead
```

---

## Fix 9: Consider Switching to Zonos (Strategic)

If you decide to migrate, here's the implementation:

```python
# modal/zonos_server.py

import modal
import base64
import io
import os
import tempfile
import numpy as np

app = modal.App("zonos-tts")

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("espeak-ng", "ffmpeg", "git")
    .pip_install(
        "torch==2.4.0",
        "torchaudio==2.4.0",
        "fastapi",
        "uvicorn",
        "soundfile",
        "numpy",
    )
    .run_commands(
        "git clone https://github.com/Zyphra/Zonos.git /zonos",
        "cd /zonos && pip install -e ."
    )
)

@app.cls(
    gpu="L4",
    image=image,
    scaledown_window=300,
    timeout=600,
)
class ZonosServer:
    @modal.enter()
    def load_model(self):
        import torch
        from zonos.model import Zonos
        
        print("Loading Zonos model...")
        self.model = Zonos.from_pretrained("Zyphra/Zonos-v0.1-transformer", device="cuda")
        print("Zonos loaded!")
        
        self._speaker_cache = {}
    
    @modal.fastapi_endpoint(method="POST")
    def generate(self, request: dict):
        import torch
        import torchaudio
        import soundfile as sf
        from zonos.conditioning import make_cond_dict
        
        text = request.get("text", "").strip()
        ref_audio_b64 = request.get("reference_audio_base64", "")
        audio_format = request.get("format", "mp3")
        speed = float(request.get("speed", 1.0))
        
        if not text or not ref_audio_b64:
            return {"error": "text and reference_audio_base64 required"}
        
        try:
            # Decode reference audio
            ref_bytes = base64.b64decode(ref_audio_b64)
            
            # Save to temp file
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                f.write(ref_bytes)
                ref_path = f.name
            
            # Load reference
            wav, sr = torchaudio.load(ref_path)
            
            # Make speaker embedding (cached)
            ref_hash = hash(ref_bytes[:1000])
            if ref_hash in self._speaker_cache:
                speaker = self._speaker_cache[ref_hash]
            else:
                speaker = self.model.make_speaker_embedding(wav, sr)
                self._speaker_cache[ref_hash] = speaker
            
            # Generate
            cond_dict = make_cond_dict(
                text=text, 
                speaker=speaker, 
                language="en-us",
                speaking_rate=speed
            )
            conditioning = self.model.prepare_conditioning(cond_dict)
            codes = self.model.generate(conditioning)
            
            # Decode
            wavs = self.model.autoencoder.decode(codes).cpu()
            
            # Save output
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                output_path = f.name
            
            torchaudio.save(output_path, wavs[0], self.model.autoencoder.sampling_rate)
            
            # Convert to requested format
            if audio_format == "mp3":
                mp3_path = output_path.replace(".wav", ".mp3")
                os.system(f'ffmpeg -y -i "{output_path}" -b:a 192k "{mp3_path}"')
                with open(mp3_path, "rb") as f:
                    audio_bytes = f.read()
            else:
                with open(output_path, "rb") as f:
                    audio_bytes = f.read()
            
            # Cleanup
            os.unlink(ref_path)
            os.unlink(output_path)
            
            return {
                "audio_base64": base64.b64encode(audio_bytes).decode("utf-8"),
                "format": audio_format,
                "sample_rate": self.model.autoencoder.sampling_rate,
            }
            
        except Exception as e:
            import traceback
            return {"error": str(e), "traceback": traceback.format_exc()}
```

### Update Chunk Size for Zonos

```typescript
// src/lib/generate-audiobook-v2.ts
// Zonos supports longer text:

const sections = splitBySentences(text, 2000); // 2x longer than F5-TTS
```

---

## Summary of Changes

| Fix | File | Lines | Impact |
|-----|------|-------|--------|
| Reduce chunk size | `generate-audiobook-v2.ts` | 92 | Critical |
| Unify loudness | `f5_tts_server_fixed.py` | 330 | Critical |
| Add VAD | `f5_tts_server_fixed.py` | 313-354 | Critical |
| Fix multi-reference | `generate-audiobook-v2.ts` | 381-550 | Critical |
| Simplify/remove LLM Director | `generate-audiobook-v2.ts` | 631-679 | High |
| Optimize NFE steps | `f5_tts_server_fixed.py` | 251 | High |
| Remove upsampling | `generate-audiobook-v2.ts` | 729 | High |
| Remove jitter | `f5_tts_server_fixed.py` | 165-170 | Medium |
| Consider Zonos | New file | - | Strategic |

---

## Testing Checklist

After implementing fixes:

- [ ] Generate audiobook with F5-TTS, verify no truncation
- [ ] Check loudness consistency across pipeline
- [ ] Verify VAD trims silence correctly
- [ ] Test multi-reference with 3 samples, verify best is selected
- [ ] Measure latency improvement without LLM Director
- [ ] Compare 24kHz vs 44kHz output (blind test)
- [ ] Test Zonos alternative (if implemented)
- [ ] A/B test with users (quality perception)
