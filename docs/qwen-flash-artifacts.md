# Qwen 3.1 Flash clone artifacts: diagnosis

Model: `qwen-audio-3.1-tts-flash` (Model Studio, Singapore). Listeners hear
**metallic / robotic**, **patchy / chopped**, and **gurgly / wobbly**
narration. A take often "sounds great for ~10 s, then goes wobbly".

**Status.** After listening, Joel rated the raw render better than the
de-line/de-gate repair below, so the repairs are **not** the fix. They stay
behind `QWEN_TTS_POST=deline,degate`, off by default. The gurgle (smeared
harmonics above ~1.5 kHz) is the problem that matters. It is unchanged by
any post-processing and is being worked on with live renders.

## What is wrong, measured

Three signal faults, each with a CPU detector in
[`scripts/qwen/artifact_qa.py`](../scripts/qwen/artifact_qa.py). The standard
MOS predictors (DNSMOS, UTMOSv2, Audiobox Aesthetics, NISQA) score these
renders as well as clean references, so they cannot be used as a gate.

| Fault | Heard as | Qwen Flash | Clean speech |
|---|---|---|---|
| Fixed spectral line, +4.5 dB at ~1215 Hz, ~90 Hz wide, then a −9 dB dip at 1310 Hz | metallic | 4.0–6.1 dB, every voice | 1.1–2.8 dB |
| Hard gating: speech snaps to digital zero within 10 ms | patchy | 19–70 cuts/min, 15–22 % of the take is digital zero | 0 cuts/min |
| Chopped word tails: a fall of ≥30 dB within 10 ms from speech level | patchy | 3–9 /min (17 /min on the pilot) | 0 /min |
| Smeared harmonics (`harm_badness`, seven robust z-scores) | gurgly | 0.61–1.11 (per-take median) | 0.16–0.47 |

The line has the same shape on every Flash voice, so it is a fingerprint of
the model, not of a reference clip.

**Reproduction.** The port reproduces the study detectors exactly on line,
cuts, digital silence, and every per-4 s window for all 12 study clips. The
pilot reads 4.33 dB / 30.6 cuts/min / mid_per 0.364 against the reported
4.34 / 30.6 / 0.364. Per-second harmonic features correlate 0.99–1.0 with
the study's, except HNR on the pilot (0.80), which is the correction below.

**One correction to the study detector.** It linearly interpolated Praat's
HNR track across the −200 dB "unvoiced" marker. That gave values around
−90 dB that passed its `< −100` filter, so `harm_badness` moved by up to
0.17 when the same audio was shifted 25 ms. The port uses the nearest
frame, which cuts that swing to ±0.03. Every study clip is unchanged
except the pilot, which reads 1.01 → 0.82: part of its score was this
artifact. For comparing two takes, use `--stable-harm`, the mean over four
segment offsets.

## The long-call hypothesis does not hold

The hypothesis was that one long call drifts, so chunking would fix it. The
study's four full single-call chapter renders (138–152 s) do not show that.
These are the study's own per-window tables (its harm values predate the HNR
correction; the direction is what matters here):

| Render | line vs time (Spearman ρ) | harm vs time ρ | harm first 20 s / rest | cuts/min first 20 s / rest |
|---|---|---|---|---|
| Q31_wolfe | −0.08 (p 0.34) | −0.08 | 0.98 / 0.97 | 30 / 45 |
| Q31d_wolfe | −0.10 (p 0.24) | −0.13 | 1.12 / 0.99 | 30 / 43 |
| Q31_vdh | +0.09 (p 0.26) | −0.26 (p 0.003) | 1.15 / 0.90 | 18 / 35 |
| Q31d_vdh | −0.09 (p 0.27) | −0.21 (p 0.016) | 1.00 / 0.79 | 18 / 22 |

- The metallic line has no time trend.
- Harmonic smearing gets slightly *better* later in a call.
- Only the cut rate is lower in the first 20 s. Cuts follow pauses: they
  track the pause count per 4 s window (ρ 0.48, p 0.002). Short ~12–18 s
  calls are already gated at 25–70 cuts/min. So the "fine for 10 s, then
  wobbly" impression is most likely the first long pause, not call length.

Chunking alone is therefore not expected to fix the sound. The provider still
chunks: it bounds retries, lets chunks run in parallel, and makes a bad take
cheap to replace. The A/B runner below tests the hypothesis directly. It
includes a control with the same words in reverse paragraph order, which
separates position in the call from content.

## Repairs tried (experimental, off by default; rated worse than raw by ear)

All of it is general (any book, any voice) and runs locally on CPU after the
API returns.

1. **De-line** (`QWEN_DELINE`): a peaking cut of −4.5 dB, 90 Hz wide at
   1215 Hz. The line drops from 4.0–5.3 dB to 1.7–2.5 dB, which is the
   clean-reference range. The long-term spectrum moves ≤0.25 dB outside
   ±200 Hz.
2. **De-gate** (`degatePcm`): every run of digital zero gets a quiet room
   bed (−66 dB below speech peak, low-passed noise). The bed reaches full
   level at the gap edge, so the floor no longer switches on and off. A word
   chopped from speech level gets a short reverb-style decay (its last 10 ms
   convolved with ~12 ms exponential noise). Other edges get a 4 ms ramp.
3. **Chunked synthesis** (`qwen-chunks.ts`): ~220 characters per call
   (~12 s), at sentence boundaries, never across a paragraph. Takes are
   level-matched (±6 dB) and joined with pauses sized to the boundary:
   paragraph 750 ms, sentence 420 ms (Qwen's own median inner pause is
   400 ms), clause 180 ms.
4. **Seeded candidates** (`candidates` + `scorer` on `renderQwenText`; the
   A/B runner's `--candidates N`): render N seeds per chunk and keep the take
   with the lowest `harm_badness`. This is the only lever here on smeared
   harmonics, which no post-process can fix. It costs N× characters and
   needs the Python scorer, so the provider does not turn it on by itself.

Repairs on the study clips, measured on the same audio (no new API calls):

| Clip | line dB | cuts/min | steep/min | digital silence % | harm stable |
|---|---|---|---|---|---|
| wolfe first 40 s, raw → repaired | 4.81 → 1.97 | 51.0 → 1.5 | 7.5 → 0.0 | 21.3 → 0.0 | 0.95 → 0.93 |
| vdh first 40 s | 5.32 → 2.10 | 19.5 → 1.5 | 3.0 → 0.0 | 15.9 → 0.9 | 0.83 → 0.92 |
| vdh, 6 s ref, 40 s | 4.50 → 2.53 | 38.8 → 0.0 | 8.9 → 1.5 | 18.1 → 0.0 | 0.82 → 0.87 |
| wolfe, 15 s ref, 40 s | 4.02 → 1.66 | 38.4 → 1.6 | 4.8 → 0.0 | 16.0 → 0.0 | 0.67 → 0.68 |

Caveats:

- After de-gate the cut count is low partly by construction, because the bed
  lifts the floor above the −75 dB cut threshold. `steep_decays_per_min` does
  not depend on the floor and is the check to trust there.
- `harm_badness` does not improve; it moves −0.02 to +0.09. Smeared
  harmonics are inside the model's audio. Seeded candidates are the lever,
  and the A/B measures them.
- These numbers rank takes. They do not replace listening.

## Running the A/B (needs the key; I could not run it)

```bash
python3 -m venv .venv-qwen && .venv-qwen/bin/pip install -r scripts/qwen/requirements.txt
printf 'DASHSCOPE_API_KEY=...\nDASHSCOPE_WORKSPACE_ID=...\n' > .env.qwen   # gitignored by .env*

# Plan and character cost only, no calls:
npx tsx scripts/qwen/ab-chapter.ts --text page.txt --voice <voice_id> --out /tmp/qwen-ab/run1 \
  --control --candidates 3 --determinism --dry-run

# The run (~2,600 chars of page.txt; ~3 pages of characters without candidates):
QWEN_QA_PYTHON=.venv-qwen/bin/python npx tsx scripts/qwen/ab-chapter.ts \
  --env-file .env.qwen --text page.txt --voice <voice_id> --seed 42 \
  --out /tmp/qwen-ab/run1 --control --determinism
```

- `page.txt` is any chapter text. The runner takes the first ~2,600
  characters on a paragraph or sentence boundary (`--chars`).
- `--candidates 3` adds the seeded-candidate arm: two extra calls per
  chunk.
- `--max-chars` (default 12,000) refuses a plan over budget.
- `--fake` runs the whole pipeline offline on synthetic audio.

Outputs in `--out`:

- `single.mp3`, `single-post.mp3`, `chunked.mp3`, `chunked-post.mp3`, and
  with the flags above `control.mp3`, `chunked-best.mp3`.
- `chunks/`: the raw per-chunk takes.
- `runs.jsonl`: one line per call with arm, chunk, characters, seed,
  request id, audio host, latency and attempts. It holds no key and no
  signed link.
- `qa.json` and `windows.csv`: per-4 s metrics.
- `report.md`: the tables above for this run, plus first-20 s vs rest.

How to read it:

- **Long-call drift is real** only if `single` is worse after 20 s **and**
  `control` is too.
- **Chunking helps** only if `chunked` beats `single` on harm stable by
  more than ~0.1.
- **Seed determinism**: the `--determinism` line says whether the same seed
  repeats.

QA alone on any files:

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
| `QWEN_TTS_SEED` | 42 | 0–65535 |
| `QWEN_TTS_CHUNK_CHARS` | 220 | 80–600 |
| `QWEN_TTS_CONCURRENCY` | 3 | chunk calls in flight, 1–8 |
| `QWEN_TTS_POST` | `off` | `deline,degate` opts into the experimental repairs (rated worse than raw by ear) |
