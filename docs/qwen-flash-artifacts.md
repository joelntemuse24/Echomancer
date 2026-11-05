# Qwen 3.1 Flash clone artifacts: diagnosis and live API experiments

Model: `qwen-audio-3.1-tts-flash` (Model Studio, Singapore). Listeners hear
**metallic / robotic**, **patchy / chopped**, and **gurgly / wobbly**
narration. A take often "sounds great for ~10 s, then goes wobbly".

**Status.** After listening, Joel rated the raw render better than the
de-line/de-gate repair below, so the repairs are **not** the fix. They stay
behind `QWEN_TTS_POST=deline,degate`, off by default. Live API experiments
were run across 13,383 billed characters (under the 14k budget) to test every
available API lever on the gurgle, fixed line, and hard gating.

## Bottom line from live API experiments

1. **Metric validation (`hf_flutter_db` vs `harm_badness`):**
   - `harm_badness` is **inverted** on Ryan: it rates Ryan *worse* (`1.769`
     on the 324-char kitten text) than Wolfe (`0.996`) and VDH (`0.982`),
     because Ryan's synthetic reference has lower Praat autocorrelation
     periodicity (`mid_per = 0.253`) even though its output has zero hard
     cuts and sounds clean to human ears. Do **not** optimize `harm_badness`
     across voices.
   - The metrics that rank **Ryan cleanest → VDH middle → Wolfe worst** on the
     identical 324-char text are:
     - **`hf_flutter_db`** (fast 15+ Hz level fluctuation in 1.5–4 kHz inside
       voiced runs ≥100 ms): Clean Edge/Paradee previews `1.48–2.04 dB`,
       **Ryan `2.51 dB`**, **VDH `2.69 dB`**, **Wolfe `2.86 dB`**.
     - **`cuts_per_min` / `steep_decays_per_min`**: **Ryan `0.0 / 0.0`**,
       **VDH `16.6 / 3.3`**, **Wolfe `53.9 / 20.2`**.
     - **`line_db`** (1.21 kHz stationary tone): **Ryan `4.65 dB`**,
       **Wolfe `5.13 dB`**, **VDH `5.66 dB`**.
2. **Multi-seed candidate selection does NOT work on `qwen-audio-3.1-tts-flash`:**
   - Live renders with `seed=42`, `seed=7`, `seed=123`, and `seed=999`
     returned **byte-identical MP3 files** (`356,251` bytes, SHA-256
     `9ed10c5ce2` on all four).
   - Tested over WebSocket (`ws` transport, `parameters.seed=42` vs `7`) and
     HTTP (`parameters.seed=7` vs `input.seed=42`): also **byte-identical**
     (`95,131` bytes, SHA-256 `2a9df3b000` on WS; `86,011` bytes, SHA-256
     `993c6678ba` on HTTP).
   - `qwen-audio-3.1-tts-flash` is deterministic on `(voice, text, rate, pitch)`
     and ignores `seed`. Multi-seed candidate selection (`--candidates N`)
     spends `N×` characters for the exact same audio and must stay off (`1`).
3. **WAV vs MP3, 48 kHz, SSE, WebSocket, SSML, and Plus:**
   - **SSE (`X-DashScope-SSE: enable`)** returns the exact same MP3 bytes as
     plain HTTP (`9ed10c5ce2`) in half the wall time (`2.33 s` vs `4.15 s`).
   - **WAV 24 kHz and WAV 48 kHz** have identical metrics (`hf_flutter_db = 2.77`,
     `line_db = 5.17`, `cuts_per_min = 54.1`). Requesting 48 kHz only doubles
     payload size (`1.70 MB` vs `0.85 MB`); the audio is still band-limited
     at ~11.5 kHz. WAV 24 kHz is `0.09 dB` cleaner on `hf_flutter_db` than
     128 kbps MP3 (`2.77` vs `2.86`) solely from avoiding MP3 quantization.
   - **WebSocket (`ws`)** cuts `cuts_per_min` (`53.9 → 28.0`) and
     `steep_decays_per_min` (`20.2 → 7.0`), but **worsens** the gurgle
     (`hf_flutter_db = 3.02`) and raises the 1.21 kHz metallic line to
     `6.65 dB`.
   - **SSML (`enable_ssml=true` with `<break>` tags)** worsens both gurgle
     (`hf_flutter_db = 3.13`) and gating (`cuts_per_min = 62.0`).
   - **Plus (`qwen-audio-3.1-tts-plus`)** nearly eliminates hard gating
     (`cuts_per_min = 3.9` on Wolfe, `3.7` on VDH), **but its 1.5–4 kHz
     harmonic flutter is worse than Flash** (`hf_flutter_db = 3.31` on Wolfe,
     `2.87` on VDH) and its 1.21 kHz line is still `4.85–5.10 dB`.
4. **Enrolling a Flash voice from a Plus render of Wolfe / VDH (tested 6 variants):**
   - Enrolled 6 Flash voices from Plus renders (`fpwolfe6` 6 s prepared,
     `fpwolfep` 6 s with `enable_preprocess=true`, `fpwolfe15` full 15.5 s,
     and the same three for VDH: `fpvdh6`, `fpvdhp`, `fpvdh15`).
   - **All 6 made the gurgle significantly worse:** `hf_flutter_db` rose from
     `2.86 → 3.31–3.78 dB` on Wolfe and `2.69 → 3.42–3.57 dB` on VDH. Because
     Plus output already has `3.31 / 2.87 dB` of 1.5–4 kHz vocoder flutter and
     a `~5 dB` 1.21 kHz line, cloning from Plus compounds the vocoder imprint
     in Flash (unlike Ryan, whose reference came from Edge TTS with
     `hf_flutter_db = 1.88 dB` and `line_db = 2.09 dB`).
   - `enable_preprocess=true` increased the 1.21 kHz metallic line by `+1.0 dB`
     (`5.48 → 6.43 dB` on Wolfe, `5.94 → 6.84 dB` on VDH) and increased cuts.
     Keep `enable_preprocess=false`.
5. **What actually reduces the gurgle / artifacts on Flash:**
   - **Short dense reference enrollment (`wryan57`, 5.7 s dense studio slice,
     peak 0.70, `enable_preprocess=false`):** cuts Wolfe's hard gating by 43 %
     (`53.9 → 30.6 cuts/min`), lowers the 1.21 kHz line by `0.80 dB`
     (`5.13 → 4.33 dB`), and improves mid-band periodicity (`0.352 → 0.371`).
     On the full 2,582-char chapter passage, `wryan57` lowers `hf_flutter_db`
     to **`2.72 dB`** (vs `2.82 dB` on `ewolfe`), `line_db` to **`4.35 dB`**,
     `cuts_per_min` to **`31.0`** (vs `43.9–51.0`), and `harm_badness_stable`
     to **`0.795`** (vs `0.948–0.977`).
   - **For VDH**, the baseline 15 s studio enrollment (`evdh`) is already the
     cleanest voice (`hf_flutter_db = 2.23 dB` on the 2,582-char chapter,
     `2.35 dB` on first 40 s, `cuts_per_min = 16.6` on short text).
   - **Gentle pace (`rate=0.92`) or pitch (`pitch=0.97`):** on the 324-char
     text, `rate=0.92` reduces `hf_flutter_db` by **`0.16–0.18 dB`** across
     all tested voices (`ewolfe`: `2.86 → 2.68 dB`, `line_db` `5.13 → 4.46 dB`;
     `wryan57`: `2.84 → 2.68 dB`, `harm_badness_stable` `0.818 → 0.729`;
     `evdh`: `2.69 → 2.60 dB`, `line_db` `5.66 → 5.14 dB`). However, it slows
     delivery by ~8 % and can slightly increase pause cut counts on VDH
     (`16.6 → 30.5/min`), so `QWEN_TTS_RATE` and `QWEN_TTS_PITCH` are exposed
     as opt-in provider knobs rather than forced by default.

---

## Complete live experiment table (324-char kitten text)

All renders below used `text.txt` (324 chars; 423 chars for SSML) on
`qwen-audio-3.1-tts-flash` (except the two `plus_*` rows on
`qwen-audio-3.1-tts-plus`).

| Clip / Experiment | Voice ID (short) | s | `hf_flutter_db` ↓ | `line_db` ↓ | `cuts/min` ↓ | `steep/min` ↓ | `dig.sil %` | `harm_stable` | `mid_per` ↑ | SHA-256 (10) |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| **Clean stock previews (Edge / Paradee)** | `ava` / `andrew` / `ryan` / `standard` | 4.2–6.1 | **1.48–2.04** | **1.36–2.75** | **0.0** | **0.0** | 20–30 | 1.02–1.38 | 0.19–0.31 | — |
| **Ryan Flash baseline** (`ryan_s42.mp3`) | `eryan-12b8e245` | 19.5 | **2.51** | **4.65** | **0.0** | **0.0** | 15.9 | 1.769 | 0.253 | `c80a9d08b1` |
| **VDH Flash baseline** (`vdh_s42.mp3`) | `evdh-2c20837f` | 18.1 | **2.69** | 5.66 | **16.6** | **3.3** | 18.1 | 0.982 | 0.323 | `2cd2109f54` |
| **Wolfe Flash baseline** (`wolfe_s42.mp3`) | `ewolfe-a09d7e3b` | 17.8 | 2.86 | 5.13 | 53.9 | 20.2 | 19.3 | 0.996 | 0.352 | `9ed10c5ce2` |
| **Wolfe 5.7 s dense ref** (`pilot_wolfe_ryanlike.mp3`) | `wryan57-1ce00f7d` | 17.7 | 2.84 | **4.33** | **30.6** | 17.0 | 18.0 | **0.818** | **0.371** | — |
| Wolfe `seed=7` (`wolfe_s7.mp3`) | `ewolfe-a09d7e3b` | 17.8 | 2.86 | 5.13 | 53.9 | 20.2 | 19.3 | 0.996 | 0.352 | `9ed10c5ce2` |
| Wolfe `seed=123` (`wolfe_s123.mp3`) | `ewolfe-a09d7e3b` | 17.8 | 2.86 | 5.13 | 53.9 | 20.2 | 19.3 | 0.996 | 0.352 | `9ed10c5ce2` |
| Wolfe `seed=999` (`wolfe_s999.mp3`) | `ewolfe-a09d7e3b` | 17.8 | 2.86 | 5.13 | 53.9 | 20.2 | 19.3 | 0.996 | 0.352 | `9ed10c5ce2` |
| Wolfe WAV 24 kHz (`wolfe_s42_wav24k.wav`) | `ewolfe-a09d7e3b` | 17.8 | 2.77 | 5.17 | 54.1 | 20.3 | 19.1 | 1.010 | 0.350 | `a6fbc87915` |
| Wolfe WAV 48 kHz (`wolfe_s42_wav48k.wav`) | `ewolfe-a09d7e3b` | 17.8 | 2.77 | 5.17 | 54.1 | 20.3 | 19.1 | 1.012 | 0.350 | `007f16a5d2` |
| Wolfe HTTP SSE (`wolfe_s42_sse.mp3`) | `ewolfe-a09d7e3b` | 17.8 | 2.86 | 5.13 | 53.9 | 20.2 | 19.3 | 0.996 | 0.352 | `9ed10c5ce2` |
| Wolfe WebSocket (`wolfe_s42_ws.mp3`) | `ewolfe-a09d7e3b` | 17.2 | 3.02 | 6.65 | 28.0 | 7.0 | 23.4 | 0.934 | 0.372 | `5dbaa5a0a7` |
| Wolfe `rate=0.92` (`wolfe_s42_rate092.mp3`) | `ewolfe-a09d7e3b` | 19.4 | **2.68** | **4.46** | 58.9 | 15.5 | 20.2 | 0.902 | 0.340 | `9253b7c85b` |
| Wolfe `wryan57` + `rate=0.92` (`wryan57_rate092.mp3`) | `wryan57-1ce00f7d` | 19.2 | **2.68** | 4.51 | **31.3** | **12.5** | 18.8 | **0.729** | **0.376** | — |
| VDH `evdh` + `rate=0.92` (`vdh_rate092.mp3`) | `evdh-2c20837f` | 19.7 | **2.60** | **5.14** | 30.5 | **3.0** | 17.9 | **0.864** | **0.356** | — |
| Wolfe `rate=1.05` (`wolfe_s42_rate105.mp3`) | `ewolfe-a09d7e3b` | 17.0 | 2.86 | 5.19 | 53.0 | 21.2 | 19.6 | 1.067 | 0.344 | `6e9eb22c54` |
| Wolfe `pitch=0.97` (`wolfe_s42_pitch097.mp3`) | `ewolfe-a09d7e3b` | 18.9 | **2.69** | 4.85 | 53.9 | 19.0 | 20.0 | 0.972 | **0.383** | `bf993d339d` |
| Wolfe SSML `<break>` (`wolfe_s42_ssml.mp3`) | `ewolfe-a09d7e3b` | 18.4 | 3.13 | 5.07 | 62.0 | 9.8 | 27.5 | 1.070 | 0.294 | `7d1fb1fccd` |
| **Plus Wolfe** (`plus_wolfe_s42.wav`) | `pwolfe-b2b784eb` | 15.5 | 3.31 | 5.10 | **3.9** | **3.9** | 10.2 | 1.019 | 0.380 | `bec6358fa8` |
| **Plus VDH** (`plus_vdh_s42.wav`) | `pvdh-4ae3d751` | 16.3 | 2.87 | 4.85 | **3.7** | **0.0** | 5.7 | 1.024 | 0.342 | `be4d8d7884` |
| Flash←Plus Wolfe 6 s (`fpwolfe6_s42.mp3`) | `fpwolfe6-b92cf9ef` | 17.5 | 3.41 | 5.48 | 65.2 | 20.6 | 20.9 | 0.931 | 0.337 | — |
| Flash←Plus Wolfe 6 s + preprocess (`fpwolfep_s42.mp3`) | `fpwolfep-18e60cbe` | 16.3 | 3.31 | 6.43 | 73.6 | 25.8 | 17.7 | 1.024 | 0.353 | — |
| Flash←Plus Wolfe 15 s (`fpwolfe15_s42.mp3`) | `fpwolfe15-09d3e891` | 16.9 | 3.78 | 4.67 | 42.5 | 7.1 | 26.5 | 1.149 | 0.310 | — |
| Flash←Plus VDH 6 s (`fpvdh6_s42.mp3`) | `fpvdh6-fc79fa78` | 15.3 | 3.57 | 5.94 | 46.9 | 0.0 | 16.4 | 1.270 | 0.284 | — |
| Flash←Plus VDH 6 s + preprocess (`fpvdhp_s42.mp3`) | `fpvdhp-e791277f` | 16.2 | 3.42 | 6.84 | 51.8 | 11.1 | 13.8 | 1.227 | 0.279 | — |
| Flash←Plus VDH 15 s (`fpvdh15_s42.mp3`) | `fpvdh15-e031d691` | 18.0 | 3.55 | 5.42 | 30.0 | 0.0 | 17.1 | 1.123 | 0.285 | — |

---

## Full ~2,600-char chapter renders (Wolfe & VDH)

Rendered `chapter/text.txt` (2,582 chars; 2,604 billed units each, HTTP
`format=mp3`, `sample_rate=24000`, `seed=42`, raw output with no post-processing):

| Render | Voice ID | Duration | `hf_flutter_db` ↓ | `line_db` ↓ | `cuts/min` ↓ | `steep/min` ↓ | `dig.sil %` | `harm_stable` ↓ | `mid_per` ↑ | First 20 s / rest (`harm_badness`) |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Prior `Q31_wolfe_raw` (15 s ref, 48 kHz) | `ewolfe-a09d7e3b` | 135.3 s | 2.82 (40 s) | 4.47 | 43.9 | 7.5 (40 s) | 19.5 | 0.977 | 0.333 | 0.98 / 0.97 |
| Prior `Q31d_wolfe_raw` (preprocess on) | `dwolfe-37395cb7` | 139.1 s | — | 5.09 | 41.4 | — | 22.3 | 1.028 | 0.328 | 1.12 / 0.99 |
| **New `wolfe_wryan57_chapter_2600.mp3`** (5.7 s dense ref, 24 kHz) | `wryan57-1ce00f7d` | **135.6 s** | **2.72** | **4.35** | **31.0** | **8.0** | **18.0** | **0.795** | **0.362** | **0.90 / 0.79** |
| **New `vdh_evdh_chapter_2600.mp3`** (15 s studio ref, 24 kHz) | `evdh-2c20837f` | **152.5 s** | **2.23** | **4.69** | **31.1** | **4.7** | **18.2** | **0.808** | **0.354** | **1.02 / 0.75** |

### Cost and quota spent

- **Total characters billed in this session:** `13,383` (budget cap: `14,000`),
  across `12,735` Flash characters and `648` Plus characters (~11,500 tokens
  total, ~1.1 % of the 1M-token free tier).
- **Voice enrollments:** 6 free calls (`$0`).
- **Production synthesis cost:** `qwen-audio-3.1-tts-flash` at 1× calls (no
  multi-seed multiplier), `~$0.09` per audio hour.

---

## What is wrong, measured

Four signal checks in [`scripts/qwen/artifact_qa.py`](../scripts/qwen/artifact_qa.py).
The standard MOS predictors (DNSMOS, UTMOSv2, Audiobox Aesthetics, NISQA)
score these renders as well as clean references, so they cannot be used as a gate.

| Fault | Heard as | Qwen Flash | Clean speech / Edge |
|---|---|---|---|
| **1.5–4 kHz harmonic flutter (`hf_flutter_db`)** | **gurgly / bubbly** | **2.23–3.10 dB** (Ryan 2.51, VDH 2.23–2.69, Wolfe 2.72–3.10) | **1.48–2.04 dB** (Edge/Paradee), 1.71–2.31 dB (human) |
| Fixed spectral line, +4.5 dB at ~1215 Hz, ~90 Hz wide, then a −9 dB dip at 1310 Hz | metallic | 4.0–6.1 dB, every voice | 1.1–2.8 dB |
| Hard gating: speech snaps to digital zero within 10 ms | patchy | 17–70 cuts/min (0 on Ryan), 15–22 % digital zero | 0 cuts/min |
| Chopped word tails: a fall of ≥30 dB within 10 ms from speech level | patchy | 3–20 /min (0 on Ryan) | 0 /min |
| Smeared harmonics (`harm_badness`, seven robust z-scores) | within-voice only | 0.61–1.11 on human clones (1.70 on Ryan synthetic ref) | 0.16–0.47 on human refs |

The 1.21 kHz line has the same shape on every Flash voice, so it is a
fingerprint of the model's vocoder upsampler, not of a reference clip.

**One correction to the study detector.** It linearly interpolated Praat's
HNR track across the −200 dB "unvoiced" marker. That gave values around
−90 dB that passed its `< −100` filter, so `harm_badness` moved by up to
0.17 when the same audio was shifted 25 ms. The port uses the nearest
frame, which cuts that swing to ±0.03. For comparing two takes of the same
voice, use `--stable-harm`, the mean over four segment offsets. For comparing
across voices, use `hf_flutter_db`, `cuts_per_min`, and `line_db`.

## The long-call hypothesis does not hold

The hypothesis was that one long call drifts, so chunking would fix it. The
study's four full single-call chapter renders (138–152 s) and the two new
2,582-char renders (135.6 s and 152.5 s) do not show that:

| Render | line vs time (Spearman ρ) | harm vs time ρ | harm first 20 s / rest | cuts/min first 20 s / rest |
|---|---|---|---|---|
| Q31_wolfe (`ewolfe`) | −0.08 (p 0.34) | −0.08 | 0.98 / 0.97 | 30 / 45 |
| Q31d_wolfe (`dwolfe`) | −0.10 (p 0.24) | −0.13 | 1.12 / 0.99 | 30 / 43 |
| **New `wolfe_wryan57_chapter_2600`** | — | — | **0.90 / 0.79** | **36 / 30** |
| Q31_vdh (`evdh`, 48 kHz) | +0.09 (p 0.26) | −0.26 (p 0.003) | 1.15 / 0.90 | 18 / 35 |
| Q31d_vdh (`dvdh`, 48 kHz) | −0.09 (p 0.27) | −0.21 (p 0.016) | 1.00 / 0.79 | 18 / 22 |
| **New `vdh_evdh_chapter_2600`** (24 kHz) | — | — | **1.02 / 0.75** | **21 / 30** |

- The metallic line has no upward time trend.
- Harmonic smearing gets slightly *better* later in a call (`0.90 → 0.79` on
  `wryan57`, `1.02 → 0.75` on `evdh`).
- Cuts follow pauses: they track the pause count per 4 s window (ρ 0.48,
  p 0.002). Short ~12–18 s calls are already gated at 17–70 cuts/min.

Chunking alone does not change the vocoder's harmonic texture, though the
provider still chunks (`qwen-chunks.ts`) to bound retries and run chunks in
parallel.

## Repairs tried (experimental, off by default; rated worse than raw by ear)

1. **De-line** (`QWEN_DELINE`): a peaking cut of −4.5 dB, 90 Hz wide at
   1215 Hz. The line drops from 4.0–5.3 dB to 1.7–2.5 dB.
2. **De-gate** (`degatePcm`): every run of digital zero gets a quiet room
   bed (−66 dB below speech peak, low-passed noise) and chopped word tails
   get a short reverb-style decay.
3. **Chunked synthesis** (`qwen-chunks.ts`): ~220 characters per call
   (~12 s), at sentence boundaries, never across a paragraph.

## QA CLI

```bash
python3 scripts/qwen/artifact_qa.py take.mp3 [...] --window 4 --stable-harm --json qa.json --csv windows.csv
python3 -m pytest scripts/qwen/test_artifact_qa.py   # QWEN_QA_CLIPS=<dir> also checks the study clips
```

## Provider

`src/lib/tts/providers/qwen.ts` registers as stock provider `qwen` and is
not in the customer catalog. It holds the only two network functions:
`qwenSynthesizeOnce` (speech) and `qwenCustomization` (voice enrollment).

- The key is read from env and redacted from every error.
- Audio links are switched to https before download.
- 429, 5xx, network errors and silent audio are retried (4 attempts) and
  honour `Retry-After`; other 4xx responses are not retried.
- `createQwenVoice` enrolls from a reference that `prepareQwenReference`
  cuts to the densest ~6 s of speech: trimmed, padded, peak 0.70, 24 kHz,
  Alibaba preprocessing off.

| Env | Default | |
|---|---|---|
| `DASHSCOPE_API_KEY` (or `QWEN_TTS_API_KEY`) | – | required |
| `DASHSCOPE_WORKSPACE_ID` | – | builds `https://<ws>.ap-southeast-1.maas.aliyuncs.com/api/v1` |
| `DASHSCOPE_BASE_URL` | – | full override of that base |
| `QWEN_TTS_MODEL` | `qwen-audio-3.1-tts-flash` | |
| `QWEN_TTS_SEED` | 42 | 0–65535 (passed to API; Flash currently ignores seed) |
| `QWEN_TTS_RATE` | unset | optional speech rate `0.5–2.0` (e.g. `0.92` lowers `hf_flutter_db` by ~0.17 dB) |
| `QWEN_TTS_PITCH` | unset | optional pitch scale `0.5–2.0` |
| `QWEN_TTS_CHUNK_CHARS` | 220 | 80–600 |
| `QWEN_TTS_CONCURRENCY` | 3 | chunk calls in flight, 1–8 |
| `QWEN_TTS_POST` | `off` | `deline,degate` opts into the experimental repairs (rated worse than raw by ear) |
