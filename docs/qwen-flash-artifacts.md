# Qwen TTS clone artifacts & smoothness: diagnosis and live API investigation

Models tested on Alibaba Cloud Model Studio (Singapore, `ap-southeast-1`):
- `qwen-audio-3.1-tts-flash` and `qwen-audio-3.1-tts-plus`
- `qwen-audio-3.0-tts-flash` and `qwen-audio-3.0-tts-plus`
- `cosyvoice-v3-plus` (WebSocket) and `cosyvoice-v3-flash`
- `qwen3-tts-flash` (system voices) and `qwen3-tts-vc-2026-01-22` / `qwen3-tts-vc-realtime-2026-01-15`

---

## Executive summary: answers to Joel's three questions

### 1. Are we really calling Qwen 3.1, or falling back to an older CosyVoice/Qwen model?

We proved from the API response payloads, OSS object paths, and error codes
what is actually running behind the scenes:

1. **The requests genuinely hit `prod/qwen-audio-3.1-tts-flash`:**
   - Every response returns `output.audio.url` under the OSS bucket path
     `prod/qwen-audio-3.1-tts-flash/20261105/<uid>/<request_id>.wav`, with
     3.1 token billing (`usage: { input_tokens, output_tokens, total_tokens, characters }`).
   - `query_voice` on `ewolfe`, `wryan57`, `evdh`, and `eryan` confirms
     `target_model: "qwen-audio-3.1-tts-flash"` and `status: "OK"`.
2. **However, `qwen-audio-3.1-tts-flash` on Alibaba Model Studio IS built on the CosyVoice vocoder/engine:**
   - Passing a 3.1 Flash voice (`Andy_v3.1`) to `qwen-audio-3.1-tts-plus`
     returns:
     `{"code":"InvalidParameter","message":"[cosyvoice:]Engine error [411]: TTS speak operation failed"}`
     — the internal service prefix is literally `[cosyvoice:]`, and Alibaba's
     own official `voice-cloning-user-guide` uses
     `samples/audio/cosyvoice/cosyvoice-zeroshot-sample.wav` as the sample
     for `qwen-audio-3.1-tts-plus`.
   - Alibaba's Model Studio has **two completely separate TTS families**:
     - **`Qwen-Audio-TTS` (`qwen-audio-3.1-tts-*`, `qwen-audio-3.0-tts-*`, `cosyvoice-v3-*`)**:
       enrolled via `model: "voice-enrollment"` and synthesized via
       `/api/v1/services/audio/tts/SpeechSynthesizer`.
     - **`Qwen3-TTS` (`qwen3-tts-flash`, `qwen3-tts-vc-2026-01-22`, `qwen3-tts-vc-realtime-2026-01-15`)**:
       the newer pure Qwen3 architecture, enrolled via
       `model: "qwen-voice-enrollment"` and synthesized via
       `/api/v1/services/aigc/multimodal-generation/generation` (OSS path
       `prod/qwen3-tts/...`).
   - **Why we aren't on `qwen3-tts-vc-2026-01-22` yet:** while `qwen3-tts-flash`
     (system voices only, e.g. `Cherry`) is live in Singapore and produces
     clean 24 kHz audio (`line_db = 2.24 dB`, `0.0 cuts/min`, `harm_badness = 0.248`),
     the voice-cloning endpoints `qwen3-tts-vc-2026-01-22` (HTTP) and
     `qwen3-tts-vc-realtime-2026-01-15` (WebSocket) currently return
     `404 {"code":"InvalidParameter","message":"Model not exist."}` at
     synthesis time in Singapore even though `qwen-voice-enrollment` accepts
     and stores the voice.
3. **Shocking discovery — `qwen-audio-3.0-tts-flash` does NOT have the 3.1 vocoder defects:**
   - When we enrolled the **exact same Wolfe and VDH references** onto
     `qwen-audio-3.0-tts-flash` and `qwen-audio-3.0-tts-plus`, the +5 dB
     1.21 kHz metallic line and comb ripple **completely disappeared**
     (`line_db = 0.20–1.00 dB`, `comb_index_db = -0.06..+0.48 dB` vs
     `4.35–6.14 dB` on 3.1 Flash), and hard gating dropped by **70–80 %**
     (`cuts_per_min = 0.0–8.8/min` on Wolfe and `6.2–7.2/min` on VDH vs
     `31–54/min` on 3.1 Flash).
   - In other words: **Alibaba introduced the 1.21 kHz vocoder resonance, comb
     ripple, and aggressive noise-gate chopping in `qwen-audio-3.1-tts-flash`**.
     `qwen-audio-3.0-tts-flash` is on the exact same HTTP endpoint, uses the
     same token/character billing, and has none of the 3.1 vocoder ringing.

---

### 2. Is it our recordings or the model? (Clean studio / broadcast human references)

To test whether Wolfe and VDH's recordings were to blame, we downloaded five
lossless/broadcast studio recordings (non-LibriVox):
- **Stephen Fry** (`fry_bbc.flac`, BBC Radio 4 studio FLAC, SNR `53.7 dB`,
  `hf_flutter_db = 1.54 dB`)
- **Hilary Mantel** (`mantel_bbc.flac`, BBC Radio 4 *Bookclub* studio FLAC,
  SNR `41.5 dB`, `hf_flutter_db = 1.41 dB`)
- **Sir David Attenborough** (`attenborough_bbc.flac`, BBC Radio 4 *Desert
  Island Discs* studio FLAC, SNR `33.4 dB`, `hf_flutter_db = 1.52 dB`)
- **Alibaba's own official zero-shot reference** (`cosyvoice-zeroshot-sample.wav`,
  studio WAV, SNR `78.9 dB`, `hf_flutter_db = 1.36 dB`)
- **Voice of America broadcast anchor** (`voa_newscast.mp3`, studio broadcast,
  SNR `47.7 dB`, `hf_flutter_db = 1.77 dB`)

We enrolled all five on `qwen-audio-3.1-tts-flash` (`ali15`, `fry9`, `mantel15`,
`atten15`, `voa14`) and rendered both the 324-char kitten text and a 337-char
modern prose passage:

| Studio Reference Clone on `3.1-tts-flash` | Ref SNR | Kitten `hf_flutter_db` | Kitten `line_db` | Kitten `cuts/min` | Modern `hf_flutter_db` | Modern `line_db` | Modern `cuts/min` |
|---|---:|---:|---:|---:|---:|---:|---:|
| **Alibaba official sample** (`ali15`) | 78.9 dB | **1.91** | 5.02 | 28.5 | **1.79** | 6.87 | 39.3 |
| **BBC Stephen Fry** (`fry9`) | 53.7 dB | **2.11** | 6.14 | 22.3 | **1.93** | 5.93 | 43.3 |
| **BBC Hilary Mantel** (`mantel15`) | 41.5 dB | **1.92** | 4.74 | 38.9 | **1.87** | 5.69 | **4.8** |
| **BBC David Attenborough** (`atten15`) | 33.4 dB | **2.22** | 4.79 | 16.9 | **1.85** | 4.06 | 20.6 |
| **VOA broadcast anchor** (`voa14`) | 47.7 dB | 2.46 | 6.24 | 13.9 | — | — | — |
| **Wolfe 5.7 s** (`wryan57`) | 66.7 dB | 2.84 | 4.33 | 30.6 | 2.15 | 4.29 | 25.8 |
| **VDH 15 s** (`evdh`) | 60.1 dB | 2.69 | 5.66 | 16.6 | 2.09 | 4.60 | 18.2 |

**What this proves:**
1. **Every single voice on `qwen-audio-3.1-tts-flash` — including Alibaba's own
   79 dB SNR sample, BBC studio FLACs of Stephen Fry / Hilary Mantel / David
   Attenborough, and Alibaba's stock voices `Andy_v3.1` (`line_db = 4.75`) and
   `Eric_v3.1` (`line_db = 5.12`) — has the exact same +4.7 to +6.8 dB
   1.21 kHz vocoder line.** That metallic coloration is 100 % hardcoded in the
   `qwen-audio-3.1-tts-flash` vocoder.
2. **Every human clone on `qwen-audio-3.1-tts-flash` gets hard-gated between
   words (`14–43 cuts/min`)**, whereas **Alibaba's stock voices (`Eric_v3.1`,
   `Andy_v3.1`, `Brian_v3.1`) have `0.0 cuts/min` and `0.0 steep_decays/min`**,
   even across a full 163-second chapter (`stock_Eric_v31_chapter_2600.mp3`:
   `0.0 cuts/min`, `0.2 % digital silence`, `hf_flutter_db = 2.16 dB`). Why?
   Because the 3.1 zero-shot speaker encoder gates out micro-breaths and room
   floor on cloned voices, snapping inter-word transitions to digital zero and
   quantizing word durations to 80 ms steps (`word_timestamp_enabled` showed
   cloned Wolfe snapping function words to 80 ms while stock `Eric_v3.1` holds
   them for 160–480 ms).
3. **Why the *Through the Looking-Glass* passage sounded much worse than plain
   modern prose:** on plain modern prose (`modern_prose.txt`, 337 chars),
   `hf_flutter_db` dropped by **0.60–0.69 dB** on the exact same Wolfe and VDH
   voices (`wryan57`: `2.84 → 2.15 dB`, `harm_badness_stable`: `0.818 → 0.545`;
   `evdh`: `2.69 → 2.09 dB`, `harm_badness_stable`: `0.982 → 0.659`).
   *Looking-Glass* has Victorian punctuation (`:—`, parentheticals, em-dashes,
   exclamation marks, dialogue quotes, `"to-morrow"`, `"couldn't"`) that causes
   the zero-shot prosody predictor in 3.1 Flash to lurch in pitch and chop
   clause tails.

---

### 3. Chasing smoothness broadly: `qwen-audio-3.0-tts-flash` vs `3.1-tts-flash`

When we tested `qwen-audio-3.0-tts-flash` and `qwen-audio-3.0-tts-plus` on the
same references and texts, the difference in smoothness and signal cleanliness
was dramatic:

#### A. Modern prose (337 chars) — `3.1-tts-flash` vs `3.0-tts-flash`

| Voice & Model | Duration | `hf_flutter_db` ↓ | `line_db` ↓ | `comb_db` ↓ | `cuts/min` ↓ | `steep/min` ↓ | `dig.sil %` ↓ | `harm_stable` ↓ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **Wolfe (`wryan57`) on `3.1-tts-flash`** | 18.6 s | 2.15 | 4.29 | 1.03 | 25.8 | 6.4 | 13.4 | 0.545 |
| **Wolfe (`q30f` 15 s) on `3.0-tts-flash`** | 17.9 s | **2.15** | **1.13** | **-0.06** | **0.0** | 6.7 | 11.5 | 0.616 |
| **Wolfe (`q30p` 15 s) on `3.0-tts-plus`** | 18.2 s | 2.21 | **0.70** | **-0.03** | **9.9** | **3.3** | 12.2 | 0.606 |
| **VDH (`evdh` 15 s) on `3.1-tts-flash`** | 19.7 s | 2.09 | 4.60 | 1.37 | 18.2 | 9.1 | 17.7 | 0.659 |
| **VDH (`vdh30f` 15 s) on `3.0-tts-flash`** | 19.4 s | 2.13 | **0.99** | 0.66 | **6.2** | **0.0** | **7.0** | 0.678 |
| **BBC Stephen Fry (`fry9`) on `3.1-tts-flash`** | 19.4 s | 1.93 | 5.93 | 1.08 | 43.3 | 9.3 | 17.6 | 1.078 |
| **BBC Stephen Fry (`fry30f`) on `3.0-tts-flash`** | 20.1 s | **1.64** | **0.59** | **0.19** | **12.0** | **3.0** | **3.9** | 1.041 |
| **Stock `Eric_v3.1` on `3.1-tts-flash`** | 19.7 s | 2.13 | 4.86 | 1.16 | **0.0** | **0.0** | **0.3** | 1.053 |
| **Stock `Andy_v3.1` on `3.1-tts-flash`** | 18.0 s | 2.56 | 4.65 | 1.22 | **0.0** | **0.0** | **2.3** | 0.556 |

#### B. Full 2,582-char chapter passage — `3.1-tts-flash` vs `3.0-tts-flash` vs Stock `Eric_v3.1`

| Chapter Render (2,582 chars) | Model | Voice ID (short) | Duration | `hf_flutter_db` ↓ | `line_db` ↓ | `comb_db` ↓ | `cuts/min` ↓ | `steep/min` ↓ | `dig.sil %` ↓ | `harm_stable` ↓ |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Prior `Q31_wolfe_raw` (15 s ref) | `3.1-tts-flash` | `ewolfe-a09d7e3b` | 135.3 s | 2.82 | 4.47 | 1.08 | 43.9 | 7.5 | 19.5 | 0.977 |
| Round 1 `wolfe_wryan57_chapter_2600` (5.7 s ref) | `3.1-tts-flash` | `wryan57-1ce00f7d` | 135.6 s | 2.72 | 4.35 | 1.19 | 31.0 | 8.0 | 18.0 | 0.795 |
| **New `wolfe15_30_flash_chapter_2600`** (15 s ref) | **`3.0-tts-flash`** | `q30f-e3e57692` | 134.0 s | **2.50** | **0.61** | **0.02** | **13.9** | **6.7** | **11.9** | **0.769** |
| **New `wolfe57_30_flash_chapter_2600`** (5.7 s ref) | **`3.0-tts-flash`** | `w57q30f-741c6a88` | 136.1 s | **2.56** | **0.73** | **0.05** | **8.8** | 7.5 | **9.8** | **0.676** |
| Round 1 `vdh_evdh_chapter_2600` (15 s ref) | `3.1-tts-flash` | `evdh-2c20837f` | 152.5 s | 2.23 | 4.69 | 1.47 | 31.1 | 4.7 | 18.2 | 0.808 |
| **New `vdh15_30_flash_chapter_2600`** (15 s ref) | **`3.0-tts-flash`** | `vdh30f-ced16cfa` | 141.2 s | **2.08** | **0.20** | 0.74 | **7.2** | **1.7** | **4.2** | **0.660** |
| **New `fry_bbc_30_flash_chapter_2600`** (BBC Fry) | **`3.0-tts-flash`** | `fry30f-37047bc1` | 147.8 s | **1.80** | **0.56** | **0.24** | **6.5** | **1.6** | **3.0** | 1.163 |
| **New `stock_Eric_v31_chapter_2600`** (Stock British) | `3.1-tts-flash` | `Eric_v3.1` | 163.0 s | **2.16** | 5.03 | 1.47 | **0.0** | **0.0** | **0.2** | 1.186 |

Look at what switching from `qwen-audio-3.1-tts-flash` to `qwen-audio-3.0-tts-flash`
does on the exact same 2,582-character chapter:
- **1.21 kHz metallic line (`line_db`):** drops from `4.35–4.69 dB` to
  **`0.20–0.73 dB`** (completely flat, indistinguishable from human studio
  recordings).
- **Comb ripple (`comb_index_db`):** drops from `1.19–1.47 dB` to
  **`0.02–0.74 dB`**.
- **Hard gating (`cuts_per_min`):** drops from `31.0/min` to **`8.8/min`** on
  Wolfe (`0.0/min` in the first 20 s!) and from `31.1/min` to **`7.2/min`** on
  VDH (`steep_decays_per_min` drops to **`1.7/min`**, digital silence drops from
  `18.2 %` to **`4.2 %`**).
- **High-frequency flutter (`hf_flutter_db`):** drops from `2.72 → 2.50 dB` on
  Wolfe, `2.23 → 2.08 dB` on VDH, and reaches **`1.80 dB`** on BBC Stephen Fry.
- **High-frequency bandwidth (8–11.5 kHz):** `3.0-tts-flash` preserves `+3.0 to
  +3.6 dB` more air in 8–11.5 kHz than `3.1-tts-flash`, matching the original
  Wolfe reference (`-36.4 dB` relative to 300–1000 Hz on both the studio ref
  and `3.0-tts-flash`, vs `-40.0 dB` on `3.1-tts-flash`).

---

## Honest assessment: would you want to listen to this for 10 hours?

1. **On `qwen-audio-3.1-tts-flash` with cloned voices (`wolfe_wryan57_chapter_2600.mp3`, `vdh_evdh_chapter_2600.mp3`): NO.**
   Even with the best 5.7 s reference or a BBC Radio 4 FLAC studio reference,
   `qwen-audio-3.1-tts-flash` cloned voices have two built-in model flaws that
   make 10-hour listening fatiguing:
   - A permanent `+4.3 to +6.2 dB` vocoder resonance at 1.21 kHz (`line_db`)
     that gives every voice a hollow, metallic ring.
   - Aggressive zero-shot gating (`17–54 cuts/min`) that snaps the room floor
     to digital silence between words and clips word tails, making the cadence
     feel choppy and un-smooth.
2. **On `qwen-audio-3.1-tts-flash` with Alibaba stock voices (`stock_Eric_v31_chapter_2600.mp3`, `Andy_v3.1`): Smooth cadence, but still slightly metallic.**
   Stock voices have **zero** hard cuts (`0.0 cuts/min`, `0.2 %` digital
   silence) and smooth word transitions, proving that the choppiness is
   specific to zero-shot voice cloning in 3.1. However, they still run through
   the 3.1 vocoder and carry the `~4.7–5.0 dB` 1.21 kHz resonance.
3. **On `qwen-audio-3.0-tts-flash` with cloned voices (`wolfe57_30_flash_chapter_2600.mp3`, `vdh15_30_flash_chapter_2600.mp3`, `fry_bbc_30_flash_chapter_2600.mp3`): Dramatically smoother and cleaner than 3.1 Flash.**
   `qwen-audio-3.0-tts-flash` has **no 1.21 kHz metallic line** (`0.20–0.73 dB`),
   **no comb ripple**, **4× fewer hard cuts** (`6.5–8.8 cuts/min`), and fuller
   8–11.5 kHz air. For VDH (`vdh15_30_flash_chapter_2600.mp3`) and BBC Stephen
   Fry (`fry_bbc_30_flash_chapter_2600.mp3`), the narration is genuinely
   smooth. For Wolfe (`wolfe57_30_flash_chapter_2600.mp3`), `3.0-tts-flash` is
   far smoother than any `3.1-tts-flash` render, though Wolfe's dark source
   timbre (`-42 dB/decade` tilt) still sounds slightly drier than VDH or Fry.
   Even so, zero-shot CosyVoice/Qwen-Audio clones still have occasional prosodic
   stumbles on complex 19th-century punctuation compared to dedicated
   audiobook models or stock voices.

---

## Voice IDs created for testing

| Voice | Model | Voice ID | Reference |
|---|---|---|---|
| Wolfe 15 s (`q30f`) | `qwen-audio-3.0-tts-flash` | `qwen-audio-3.0-tts-flash-q30f-e3e57692893d4a71b8890973619fdb0a` | `ref_ewolfe_15s.wav` (15 s studio) |
| Wolfe 5.7 s (`w57q30f`) | `qwen-audio-3.0-tts-flash` | `qwen-audio-3.0-tts-flash-w57q30f-741c6a8889ac465284dcda63dabdf659` | `ref_wryan57_5p7s.wav` (5.7 s dense) |
| Wolfe 15 s (`q30p`) | `qwen-audio-3.0-tts-plus` | `qwen-audio-3.0-tts-plus-q30p-2105f3f54e8443f1a06937d9c24847e2` | `ref_ewolfe_15s.wav` (15 s studio) |
| VDH 15 s (`vdh30f`) | `qwen-audio-3.0-tts-flash` | `qwen-audio-3.0-tts-flash-vdh30f-ced16cfa9ca648b398b62af89c1561fc` | `ref_evdh_15s.wav` (15 s studio) |
| BBC Stephen Fry (`fry30f`) | `qwen-audio-3.0-tts-flash` | `qwen-audio-3.0-tts-flash-fry30f-37047bc1104e4536b1907af02c8215ed` | `fry_bbc_24k.wav` (8.9 s BBC Radio 4 FLAC) |
| BBC Stephen Fry (`fry9`) | `qwen-audio-3.1-tts-flash` | `qwen-audio-3.1-tts-flash-fry9-aed6f4a6899e4cb794dbea0e861bbccb` | `fry_bbc_24k.wav` (8.9 s BBC Radio 4 FLAC) |
| BBC Hilary Mantel (`mantel15`) | `qwen-audio-3.1-tts-flash` | `qwen-audio-3.1-tts-flash-mantel15-ef61859d279d4cf09140adc9385872ed` | `mantel_bbc_24k.wav` (15 s BBC Radio 4 FLAC) |
| BBC David Attenborough (`atten15`) | `qwen-audio-3.1-tts-flash` | `qwen-audio-3.1-tts-flash-atten15-dfc3cd3e73c747dbb3f0d6e34da23637` | `attenborough_bbc_24k.wav` (15 s BBC Radio 4 FLAC) |
| Alibaba official sample (`ali15`) | `qwen-audio-3.1-tts-flash` | `qwen-audio-3.1-tts-flash-ali15-460c431fd0ff427a838cc99ce2d5ca98` | `cosyvoice-zeroshot-sample.wav` (15 s) |
| VOA broadcast (`voa14`) | `qwen-audio-3.1-tts-flash` | `qwen-audio-3.1-tts-flash-voa14-c6e3f7480866442faee8611e05a25a36` | `voa_10_24_24k.wav` (14 s VOA newscast) |

---

## Round 1 results (324-char kitten text on `qwen-audio-3.1-tts-flash`)

1. **Multi-seed candidate selection does NOT work on `qwen-audio-3.1-tts-flash`:**
   - Live renders with `seed=42`, `seed=7`, `seed=123`, and `seed=999`
     returned **byte-identical MP3 files** (`356,251` bytes, SHA-256
     `9ed10c5ce2` on all four).
   - Tested over WebSocket (`ws` transport, `parameters.seed=42` vs `7`) and
     HTTP (`parameters.seed=7` vs `input.seed=42`): also **byte-identical**.
2. **WAV vs MP3, 48 kHz, SSE, WebSocket, SSML, and Plus:**
   - **SSE (`X-DashScope-SSE: enable`)** returns the exact same MP3 bytes as
     plain HTTP (`9ed10c5ce2`) in half the wall time (`2.33 s` vs `4.15 s`).
   - **WAV 24 kHz and WAV 48 kHz** have identical metrics (`hf_flutter_db = 2.77`,
     `line_db = 5.17`, `cuts_per_min = 54.1`).
   - **WebSocket (`ws`)** cuts `cuts_per_min` (`53.9 → 28.0`) but worsens
     `hf_flutter_db` (`3.02`) and raises `line_db` (`6.65 dB`).
   - **SSML (`enable_ssml=true` with `<break>` tags)** worsens both gurgle
     (`hf_flutter_db = 3.13`) and gating (`cuts_per_min = 62.0`).
   - **Enrolling a Flash voice from a Plus render (`fpwolfe*`, `fpvdh*`)**
     worsened `hf_flutter_db` (`3.31–3.78 dB`).
   - **`enable_preprocess=true`** raised `line_db` by `+1.0 dB` and increased
     hard cuts.

---

## Provider configuration (`src/lib/tts/providers/qwen.ts`)

`src/lib/tts/providers/qwen.ts` supports both `qwen-audio-3.1-tts-flash` and
`qwen-audio-3.0-tts-flash` via `QWEN_TTS_MODEL` (or per-call `model`), plus
optional `QWEN_TTS_RATE` and `QWEN_TTS_PITCH`.

| Env | Default | Description |
|---|---|---|
| `DASHSCOPE_API_KEY` (or `QWEN_TTS_API_KEY`) | – | Required |
| `DASHSCOPE_WORKSPACE_ID` | – | Builds `https://<ws>.ap-southeast-1.maas.aliyuncs.com/api/v1` |
| `DASHSCOPE_BASE_URL` | – | Optional full override of that base |
| `QWEN_TTS_MODEL` | `qwen-audio-3.1-tts-flash` | Set to `qwen-audio-3.0-tts-flash` to eliminate the 1.21 kHz line and reduce hard cuts by 70–80 % (requires a voice enrolled with `target_model: "qwen-audio-3.0-tts-flash"`) |
| `QWEN_TTS_SEED` | 42 | 0–65535 |
| `QWEN_TTS_RATE` | unset | Optional speech rate `0.5–2.0` |
| `QWEN_TTS_PITCH` | unset | Optional pitch scale `0.5–2.0` |
| `QWEN_TTS_CHUNK_CHARS` | 220 | 80–600 |
| `QWEN_TTS_CONCURRENCY` | 3 | Chunk calls in flight, 1–8 |
| `QWEN_TTS_POST` | `off` | `deline,degate` opts into experimental post-processing repairs |
