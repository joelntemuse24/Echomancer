# Vanilla rerun (model-default APIs, raw passage text), seed 20250101, A10G/A10, 2026-11-04

Each passage's paragraphs were passed exactly as written, joined with "\n". The output was scored as-is, with no join, trim, fade, loudness match or added pauses.

## What "default" meant for each model
- **Ming-3.0-tts-0.5B**
  - Call: `MingTTS.synthesize(task="TTS", language_id="English", text=<whole passage>, prompt_wav_path=ref, prompt_text=ref transcript, use_spk_emb=True)`, as in the README.
  - All other settings at their defaults: the model's own `split_text(max_length=24)`, cfg 2.0, sigma 0.25, temperature 0, `trim_silence=True`.
  - The FST text normaliser was **off** because pynini isn't in the cached image. That makes no difference here: the passages contain no numbers or symbols.
- **IndexTTS-2.5**
  - Call: `IndexTTS2(use_bf16=True).infer(spk_audio_prompt=ref, text=<whole passage>, lang="EN")`.
  - All other settings at their defaults: the model's own punctuation split, `max_text_tokens_per_segment=120`, `interval_silence=200 ms`, default sampling.
- **Chatterbox Turbo**
  - Call: `ChatterboxTurboTTS.generate(text, audio_prompt_path=ref)` with all defaults (temperature 0.8, top_p 0.95, top_k 1000, repetition_penalty 1.2, norm_loudness).
  - It has no internal splitting and garbles text past ~350 characters, so I used the **naive split**: one call per paragraph, concatenated with **no added silence**.

## Results: vanilla vs tuned pipeline
Tuned numbers are the 4-take means from `../results/metrics.json`. Vanilla numbers are one take per passage, shown as Pride / Walden.

| model | run | breaths/min | fillers | voiced sounds in pauses | WER | spk sim | F0 std / range (st) | wpm | tails >150 ms (max) | audio-s per GPU-s | ~$/audio-hr | VRAM |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Ming | vanilla | 0 / 0 | 0 / 0 | 1 / 0 | 3.2% / 1.2% | 0.801 / 0.792 | 5.4/22.6 ; 2.4/7.6 | 235 / 241 | 1 / 1 (0.39 s) | 0.63 | 1.74 | 3.1 GB |
| Ming | tuned | 0 | 0 | 0 | 20.1% (text skipped or repeated) | 0.794 | 2.8 / 8.7 | 251 | 23 of 42 (3.3 s) | 0.61 | 1.80 | 3.1 GB |
| Chatterbox Turbo | vanilla | 0 / 0 | 0 / 1 ("Uh") | 0 / 0 | 0.5% / 0.8% | 0.814 / 0.785 | 8.0/26.7 ; 8.3/26.6 | 214 / 205 | 0 (0.0 s) | 2.65–2.86 | 0.40 | 3.9 GB |
| Chatterbox Turbo | tuned | 0 | 0 | 0 | 1.5% | 0.825 | 6.4 / 23.7 | 208 | 0 of 42 (0.14 s) | 3.59 | 0.31 | 3.5 GB |
| IndexTTS-2.5 | vanilla | 0 / 0 | 0 / 0 | 3 / 0 | 2.1% / 1.2% | 0.838 / 0.805 | 4.3/10.1 ; 2.3/7.8 | 231 / 256 | 1 (0.27 s) | 1.42 | 0.77 | 6.7 GB |
| IndexTTS-2.5 | tuned | 0 | 0 | 3 | 1.1% | 0.853 | 3.0 / 8.7 | 201 | 6 of 42 (0.46 s) | 1.09 | 1.01 | 6.3 GB |
| Audio8 Air (tuned, reference) | – | 0.63 | 0 | 6 | 1.4% | 0.850 | 3.0 / 10.3 | 186 | 5 of 42 (0.40 s) | 3.24 batched | ~0.34 | – |

### Notes
- **Respiro finds no breaths for any model in either run.** It still under-detects what a listener hears in Audio8, so listening remains the deciding test.
- **Ming:** the vanilla text path fixed the skipped and repeated text (WER 3.2% / 1.2%) and the long noisy clip-end tails. It is still slow (0.63× real time) and fast-talking (≈240 wpm).
- **Chatterbox:** pitch swings are even larger in vanilla (F0 std ≈8 st, range ≈27 st), so they are a model trait and not caused by our chunking. Whisper heard one "Uh" in the vanilla Walden take, at 28.6 s; worth a listen.
- **IndexTTS:** vanilla reads faster (231–256 wpm against 201 tuned) because its default 200 ms gaps are shorter than our pauses. Speaker similarity is slightly lower than tuned.
- **Speed vs the tuned run:** IndexTTS ran faster here (1.42 audio-s per GPU-s against 1.09), helped by fewer, longer segments. Chatterbox was slightly slower (2.65–2.86 against 3.59), because the default API re-encodes the reference audio on every call.

## Files
| clip | file |
|---|---|
| Audio8 | `00_audio8.mp3` |
| Ming | `01_ming.mp3` |
| Chatterbox | `02_chatterbox.mp3` |
| IndexTTS | `03_indextts.mp3` |
| Walden versions | `walden_{ming,chatterbox,indextts}.mp3` |
| per-take metrics | `metrics.json` |

The numbered clips are the Pride passage.

## Modal spend
About $0.26 for the `tts-alts-vanilla` apps (Modal billing, today, so far). All apps are stopped.
