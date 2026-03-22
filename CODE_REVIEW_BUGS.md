# Code Review: Bugs & Issues Found

## 🔴 Critical Bugs

### 1. `startTime`/`endTime` Completely Ignored
**File:** `src/lib/generate-audiobook.ts`

The voice clipping UI sets `startTime` and `endTime`, but these values are never used when processing the voice sample:

```typescript
// Line 66-75: Downloads entire file, no clipping
if (voiceStoragePath) {
  const { data: voiceData, error: voiceError } = await supabase.storage
    .from("audiobooks")
    .download(voiceStoragePath);  // ❌ No clipping applied!
  
  const voiceBuffer = Buffer.from(await voiceData.arrayBuffer());
  voiceBase64 = voiceBuffer.toString("base64");  // ❌ Full file!
}
```

**Fix:** Pass clipping parameters to Modal server for processing (implemented in v2).

---

### 2. Memory Exhaustion with Large Voice Samples
**File:** `src/lib/generate-audiobook.ts`

A 50MB voice sample becomes ~67MB base64 string, loaded into memory **for every chunk**:

```typescript
// Line 75: Converts to base64
voiceBase64 = voiceBuffer.toString("base64");

// Line 109: Sent with EVERY chunk request
const audio = await modalTTS(modalUrl, section, voiceBase64);  // ❌ Repeated 50+ times!
```

With a 50MB sample and 50 chunks, you're processing 3.3GB of base64 data.

**Fix:** Extract voice embedding once, reuse (or use streaming).

---

### 3. No Partial Failure Recovery
**File:** `src/lib/generate-audiobook.ts`

If section 99/100 fails after 30 minutes, the entire job fails and all progress is lost:

```typescript
// Line 121: Throws, loses everything
throw new Error(`Failed to generate section ${sectionIndex + 1}...`);
// ❌ No checkpoint saved!
```

**Fix:** Save checkpoints after each section (implemented in v2).

---

### 4. Temporary File Leaks on Modal Server
**File:** `modal/fish_speech_server.py`

On exception, temporary files aren't cleaned up:

```python
# Line 88-100: Creates temp files
raw_tmp = tempfile.NamedTemporaryFile(...)
# ...
if result.returncode != 0:
    return {"error": ...}  # ❌ raw_tmp never deleted!
```

**Fix:** Use try/finally or context managers (implemented in v2).

---

### 5. No Chunk Overlap = Audible Seams
**File:** `src/lib/generate-audiobook.ts`

Audio chunks are concatenated directly with no overlap:

```typescript
// Line 137: Direct concat
const fullAudio = Buffer.concat(audioSegments);  // ❌ Jarring transitions!
```

**Fix:** Add crossfade or overlap (implemented in v2 with overlap in text).

---

## 🟡 Medium Issues

### 6. Progress Updates Can Fail Silently
**File:** `src/lib/generate-audiobook.ts`

If `updateJob` fails, the error is only logged, not handled:

```typescript
// Line 221-223
if (error) {
  console.warn(`[Job ${jobId}] Failed to update status:`, error.message);  // ❌ Ignored!
}
```

**Impact:** User sees stuck progress while job actually completed.

---

### 7. No Input Validation on PDF Text
**File:** `src/lib/generate-audiobook.ts`

Extracted PDF text isn't validated before processing:

```typescript
// Line 54: Direct usage
const text = extractedText as string;  // ❌ Could be garbage/malformed
```

**Risk:** Could send garbage to TTS API, wasting money.

---

### 8. Hardcoded Timeouts
**File:** `modal/fish_speech_server.py`

```python
# Line 97: Fixed 15s trim
"-t", "15",  # ❌ Why 15? Not configurable

# Line 127: Fixed speed
speed=0.85,  # ❌ Not adjustable per request
```

---

### 9. No Rate Limiting
**File:** `src/app/api/*/route.ts`

API endpoints have no rate limiting:

```typescript
// Any user can spam uploads
export async function POST(request: NextRequest) {
  // ❌ No rate limit check!
}
```

**Risk:** Could rack up huge Modal bills or DOS the service.

---

### 10. Race Condition in Queue Updates
**File:** `src/app/dashboard/queue/page.tsx`

Realtime subscription and initial fetch can race:

```typescript
// Line 23-35: Fetch runs parallel with subscription setup
async function fetchJobs() { ... }  // Starts immediately
fetchJobs();  // ❌ Subscription not ready yet

// Line 38-55: Subscription setup
const channel = supabase.channel(...).subscribe();  // May miss updates
```

---

## 🟢 Minor Issues

### 11. Missing `json` import in Modal server
**File:** `modal/fish_speech_server.py`

```python
# Line 86: Uses json but never imported
ref_hash = json.loads(...)  # ❌ Import missing!
```

Actually looking at the code - `json` isn't used but `hashlib` is imported. Never mind, this is fine.

---

### 12. Progress Calculation Integer Division Bug
**File:** `src/lib/generate-audiobook.ts`

```typescript
// Line 128: Integer division
const progress = 25 + Math.round(((batchStart + batch.length) / sections.length) * 60);
// Works correctly with Math.round, but could be clearer
```

Not actually a bug, just confusing math.

---

### 13. No Duplicate Job Detection
**File:** `src/app/api/jobs/route.ts`

User can accidentally submit the same PDF + voice twice:

```typescript
// Line 14-33: Creates job without checking for duplicates
const { data: job, error: insertError } = await supabase
  .from("jobs")
  .insert({ ... });  // ❌ No deduplication!
```

---

### 14. Audio Upload Allows Any File Extension
**File:** `src/app/api/audio/upload/route.ts`

```typescript
// Line 38-40: Only checks extension, not magic bytes
const ext = file.name.split(".").pop()?.toLowerCase();
if (!ALLOWED_TYPES.includes(file.type) && !VALID_EXTENSIONS.includes(ext || "")) {
  // ❌ Could upload .exe renamed to .mp3
}
```

---

## ✅ Fixes Implemented in v2

| Bug | Fixed In | How |
|-----|----------|-----|
| Voice clipping ignored | `generate-audiobook-v2.ts` | Passes metadata with buffer |
| Memory exhaustion | `generate-audiobook-v2.ts` | Streams checkpoints to storage |
| No partial recovery | `generate-audiobook-v2.ts` | Saves checkpoint after each section |
| File leaks | `f5_tts_server_v2.py` | Try/finally cleanup |
| No overlap | `generate-audiobook-v2.ts` | Smart splitting with word overlap |
| Temp file cleanup | `f5_tts_server_v2.py` | Centralized cleanup list |
| Better segment extraction | `f5_tts_server_v2.py` | `_extract_best_segment()` function |

---

## 📊 Severity Summary

| Severity | Count | Description |
|----------|-------|-------------|
| 🔴 Critical | 5 | Data loss, resource leaks, broken features |
| 🟡 Medium | 5 | Reliability, performance issues |
| 🟢 Minor | 4 | Code quality, edge cases |

---

## 🎯 Priority Fixes

### Do Immediately:
1. **Fix voice clipping** - User feature is broken
2. **Add checkpoint table migration** - Run the SQL
3. **Fix temp file leaks** - Deploy v2 Modal server

### Do This Week:
4. **Implement checkpoint recovery** - Use v2 generator
5. **Add rate limiting** - Protect your Modal bills
6. **Add duplicate detection** - Prevent wasted compute

### Do Eventually:
7. **Add audio validation** - Check magic bytes
8. **Fix race condition** - Await subscription before fetch
9. **Add crossfade** - Better audio quality
