# Audio8 replacement bake-off: Ming-3.0-tts-0.5B vs Chatterbox Turbo vs IndexTTS-2.5 (2026-11-04)

## Test setup
- **Reference:** the same clean Wolfe clip (`wolfe_ref15.wav`) and transcript for every model. Respiro finds 0 breaths in the reference.
- **Passages:** Pride & Prejudice and Walden, about 1 minute each.
- **Chunking:** the same "natural" chunker as audio8-quality (1–2 sentences, ≤220 chars).
- **Seeds:** 20250101 and 1234, so 4 takes per model.
- **Joining and scoring:** `audio8q.prosody.join_natural`. Metrics come from `prosody_join_eval.py` (Respiro-en, faster-whisper WER, ECAPA speaker similarity, pyin F0) plus `fillers_tails.py` (filler-prompted Whisper, voiced bursts in pauses, per-chunk end-of-clip tails).
- **Hardware:** Modal A10G (Chatterbox was given an A10), bf16, stock APIs, bs=1.

## Results

| model | breaths/min | fillers (ASR) | voiced bursts in pauses | WER (mean) | spk sim | F0 std / range (st) | wpm | chunk tails >150 ms (max) | audio-s per GPU-s | $/audio-hr (A10G $1.10, bs1) | peak VRAM |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Audio8 Air, natural chunks (baseline) | 0.63 | 0 | 6 | 1.4% | 0.850 | 3.0 / 10.3 | 186 | 5 / 42 (0.40 s) | 3.24 batched (0.74 bs1) | 0.34 batched | ~ |
| **Ming-3.0-tts-0.5B** | 0.00 | 0 | 0 | **20.1%** (11.8%, 66% incl. Whisper loop) | 0.794 | 2.8 / 8.7 | **251** | **23 / 42 (3.3 s)** | 0.61 | 1.80 | 3.1 GB |
| **Chatterbox Turbo** | 0.00 | 0 | 0 | 1.5% | 0.825 | **6.4 / 23.7** | 208 | 0 / 42 (0.14 s) | **3.59** | **0.31** | 3.5 GB |
| **IndexTTS-2.5** | 0.00 | 0 | 3 | **1.1%** | **0.853** | 3.0 / 8.7 | 201 | 6 / 42 (0.46 s) | 1.09 | 1.01 | 6.3 GB |

### Caveats on the numbers
- Respiro-en counts 0.63/min on the Audio8 natural take, yet Joel still hears breaths in it. The automatic counters under-detect what a listener notices, so **the mp3s are the deciding test**.
- Thread concurrency (4 threads on one GPU) did not raise throughput:
  - Chatterbox: 3.66 → 1.91 audio-s/GPU-s.
  - Ming: 0.61 → 0.24.
  - IndexTTS: crashed with a CUDA assert.
- None of the stock APIs batch. Batched figures would need the IndexTTS vLLM recipe or a custom batched Chatterbox T3 loop. Neither was tested.

## Per-model findings
- **Ming:**
  - Skips and repeats text. In the s20250101 take it dropped "he agreed with Mr. Morris immediately" and "Is he married or single?". In the s1234 take it repeated the "tiresome … Design nonsense" span.
  - Speaks too fast (≈250 wpm).
  - Leaves long non-silent tails after speech ends (up to 3.3 s).
  - Slowest of the three (0.61× real time). **Rejected.**
- **Chatterbox Turbo:**
  - No breaths or fillers detected, and essentially no end-of-clip noise: max tail 0.14 s, none over 150 ms. The #287/#388 tail issue did not show up in English with rep_penalty 1.2.
  - Cheapest by far (~$0.31/audio-hr at bs1).
  - **Risk:** pitch is very animated or unstable. F0 std is 6.4 st against ≈3 st for the others, with 5–8% of frames more than 9 st above the median, scattered through the takes. These could be squeaks or pitch jumps, or pyin octave errors. **Listen for this.**
  - Speaker similarity is a bit lower than Audio8 or IndexTTS. Pauses are short (median 0.24 s).
- **IndexTTS-2.5:**
  - Best WER and speaker similarity, with a calm, Audio8-like pitch profile.
  - No breaths or fillers. A few short non-silent chunk tails (≤0.46 s, -26 to -29 dBFS); trimming these is worth a listen check.
  - About 1× real time at bs1, so ~$1/audio-hr unbatched. The vLLM recipe should cut this substantially (not tested).

## Recommendation
1. **IndexTTS-2.5 is the primary candidate** for quality (WER 1.1%, speaker similarity 0.853, natural pitch, no breaths or fillers). Next step: try its vLLM serving to bring the cost down to Chatterbox/Audio8 levels.
2. **Chatterbox Turbo is the low-cost option**, at roughly 3× cheaper. Adopt it only if listening confirms the pitch spikes are pyin artifacts rather than audible squeaks.
3. Drop Ming.

## Files
| clip | file |
|---|---|
| Audio8 | `00_audio8.mp3` |
| Ming | `01_ming.mp3` |
| Chatterbox | `02_chatterbox.mp3` |
| IndexTTS | `03_indextts.mp3` |
| Walden versions | `walden_{ming,chatterbox,indextts}.mp3` |

- The numbered clips are the Pride passage, seed 20250101, natural chunks.
- Per-take metrics are in `eval_*/metrics.json` and `eval_*/extras.json`. The aggregate is in `metrics.json`.
- **Modal spend:** $0.87 total for the tts-alts apps. That includes image builds and one failed IndexTTS start; all apps are stopped.
