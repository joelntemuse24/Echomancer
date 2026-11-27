# Why the Andrew Kokoro teacher measures well but sounds wrong

**Research only.** Nothing here was trained, deployed, or run on a GPU. Every
number was measured on a 4-vCPU CPU-only machine from the checkpoints in release
`andrew-teacher-evidence-2026-11-14` and the logs in `research/andrew-teacher/logs/`.

---

## The short version

The teacher really is Andrew. ECAPA is right. WER is right. It is also genuinely
worse to listen to than stock Kokoro, and the reason is **not** that fine-tuning
degraded the voice — the standard voice-quality scores actually go *up*.

Three things are wrong, in order of how much they matter:

| # | Finding | Evidence strength |
|---|---------|-------------------|
| 1 | **Training stopped at 3 epochs instead of 20+, and the exported checkpoint is the last one the run ever wrote.** The decoder was unfrozen for a single epoch, the GAN ran only inside that epoch, and the weights were saved at the end of it. | Logs, unambiguous |
| 2 | **The teacher is spectrally rougher than either its own training data or stock Kokoro**, and the roughness survives a decoder-only swap. It comes from a decoder whose only training was one epoch against a live discriminator. | Measured, 5 texts |
| 3 | **The exported style vector collapsed to a single row**, which alone makes the read ~8 % quicker; the teacher's prosody adds the rest, for 15 % overall. Audible as an unnatural, hurried read. | Measured, causal |

And one thing that is *not* wrong, which matters because it is the trap:

> **UTMOS, ECAPA and WER cannot see the defect.** UTMOS scores the teacher *above* the
> real Andrew references (4.46 vs 4.30–4.43). ECAPA only looks at timbre. WER only
> looks at words. All three are blind to roughness, dullness and pacing. The scorecard
> in the brief is not evidence the teacher is good — it is evidence the scorecard is
> the wrong instrument.

---

## 1. Top finding: training barely started before the weights were exported

The config asks for 3 + 3 epochs, against a StyleTTS2 reference config of **200 + 100**
— about **2 %** of the reference training budget. The logs show the run did not even
manage that cleanly.

**Stage 1** (`logs/stage1.log`, `logs/stage1_probe16.log`):

* Four aborted runs before one completed — crashes at `train_first.py:352`
  (`dl(wav..., y_rec...)`) in the MPD/MSD discriminator, plus a run that produced
  **`Mel Loss: nan` for every single step of epoch 1** and `Validation loss: nan`.
  A NaN training loss does not just waste the epoch; the saved weights are garbage.
* The run that actually produced the exported `epoch_1st_00002` is the 409-step
  one: **1,227 steps total, 3 epochs, ~19 minutes of wall clock** (369 s/epoch).

**Stage 2** (`logs/stage2.log`, 184 logged steps, 83 min wall clock):

| | mel loss | F0 loss | LM (WavLM) loss |
|---|---|---|---|
| epochs 1–2, last 30 logs (no GAN) | **0.196** | 1.791 | 0.831 |
| epoch 3, first 30 logs (GAN on) | **0.308** (+57 %) | 1.725 | **1.284** (+55 %) |
| epoch 3, last 30 logs | 0.303 | 1.733 | 1.301 |

Read that table carefully, because it is the whole story in three rows.

* `joint_epoch: 2` and `diff_epoch: 999` mean, with `range(0, 3)`, the decoder and
  style encoder are stepped for **exactly one epoch** (the last, 614 steps), and the
  diffusion branch never runs at all — `Diff Loss` is 0.00000 in all 184 logged steps.
* The **GAN switches on `start_ds`, which is gated on `diff_epoch`, not `joint_epoch`**.
  `diff_epoch` is incremented by `start_epoch`, and because `load_only_params: true`
  resets `start_epoch` to 0, the effective value is 999. So the discriminators should
  never have started — yet `Disc Loss` is clearly live from printed epoch 3 onward.
  That means the config that actually ran did **not** have `diff_epoch: 999`; the
  `config.yml` in this bundle is not the one that produced `epoch_2nd_00002`.
  The exported weights therefore correspond to a run whose GAN schedule we cannot
  reconstruct from the files here, which is itself a reproducibility problem worth fixing.
* Stage 2 took **83 minutes total** for all three epochs (22 + 22 + 39).
* `TMA_epoch: 0` in stage 1 means the GAN is on from step one — and the stage-1
  discriminator loss never settles into a productive range: it spikes to 5.35 in the
  first logged step, decays to ~3.1–3.5, and **sits at a median of 3.31 for the rest of
  the run** (3.40 / 3.32 / 3.41 mean across the three epochs). In StyleTTS2 that number
  sums four hinge terms, so it never separates real from generated audio by much: the
  adversarial game ran, but the generator was never pushed hard by it. Meanwhile the mel
  loss is still falling at the last logged step (0.568 → 0.267, minimum 0.257), which is
  the signature of a run stopped while still improving.
* In stage 2 the GAN arrives for the **final** epoch only, and the two losses that are
  measured the same way before and after both jump and stay up: WavLM 0.831 → 1.284
  (+55 %) and — from the GAN's own ledger — `GenLM Loss` starts at 0.979 and is still
  0.26–0.32 at the end. Nothing about the final 500 steps looks like recovery.

Then the exported file is `epoch_2nd_00002`. In `train_second.py` the save is
`epoch_2nd_%05d % epoch`, and the loop is `for epoch in range(start_epoch, epochs)`
with `range(0, 3)` → 3 saves, numbered 0, 1, 2. `00002` is the **third and final**
epoch. It is not "epoch 2 of a longer run"; the run is over. The checkpoint was taken
just as the GAN-driven disruption had settled, with about 580 steps of adversarial
training behind it — which is to say, one epoch's worth.

**The important caveat, stated plainly:** the log column labelled `Loss` is the running
*mel* loss, and between epochs 1–2 and epoch 3 the *target* changes. At
`epoch >= joint_epoch` the decoder is scored against the recording; before that it is
scored against its own output (see `train_second.py` around the `y_rec_gt` /
`y_rec_gt_pred` switch). So the +57 % mel jump at GAN onset is **partly a change of
yardstick, not purely a regression**. The genuinely comparable numbers are:

* the discriminator and WavLM losses, which *are* like-for-like and both jump and then
  plateau (LM 0.831 → 1.284 → 1.301, never recovering), and
* the stage-1 mel curve, which is still falling at the last logged step.

The conclusion holds either way — one adversarial epoch is not enough to train a
vocoder — but do not quote "+57 %" as a pure quality regression.

![Stage 2 loss curves](figures/fig7_training.png)

![Stage 1 loss curves](figures/fig8_stage1.png)

**Blunt version for a non-ML reader:** the model was trained for about 19 minutes of
stage 1 and 83 minutes of stage 2 — against a reference budget of hundreds of epochs.
The vocoder was only allowed to learn during the last half-hour, one epoch's worth, and
then the weights were saved. Fine-tuning a voice model is normally an
overnight-to-multi-day job; this was a coffee break.

---

## 2. What "weird quality" actually is: it is rougher and duller, and the scores miss it

I rendered the same paragraph with four models — stock Kokoro, stock Kokoro plus the
teacher's style vector, stage-1 teacher, stage-2 teacher — and scored them six ways.

### The standard scores say the teacher is *better*

| Render | UTMOS ↑ | PESQ ↑ |
|---|---|---|
| Andrew reference (Edge, 0.85×) — clip 1 | 4.30 | 0.989 |
| Andrew reference (Edge, 0.85×) — clip 2 | 4.40 | 0.988 |
| Andrew book MP3 (the source) | 4.43 | 0.985 |
| Stock Kokoro | 4.40 | 0.994 |
| Stock + teacher style | **4.49** | 0.990 |
| Teacher stage 1 | **4.49** | 0.987 |
| Teacher stage 2 | **4.46** | 0.988 |

UTMOS rates the rejected teacher (4.46) **above every one of the three real Andrew
clips** (4.30–4.43). That is the whole problem with the scorecard: UTMOS was trained on
MOS labels for naturalness, and a smooth, clean, low-bandwidth voice with fluent prosody
scores well even when a listener hears it as slightly hollow. ECAPA compares a speaker
embedding — it will happily confirm "this is Andrew" for a voice that is audibly wrong.

These are *my* CPU re-measurements of the bundle's own files, not the harness that
produced the brief's numbers, so treat them as a consistent *ordering* rather than as
reproductions of the original 4.46.

### The measurement that does separate them

Two things a listener actually hears, both measurable, both missed by the scores above:

**a) The teacher is spectrally dark — it inherited a dull top end from its target.**

| Signal | 99 % spectral roll-off | energy 6–8 kHz (rel. 100–300 Hz) |
|---|---|---|
| Andrew reference (the training target) | 2 859 Hz | −30.9 dB |
| Andrew book MP3 (the 0.85× source) | 3 105 Hz | −31.4 dB |
| Stock Kokoro (`am_michael`) | **6 855 Hz** | −12.0 dB |
| Teacher stage 2 | 3 738 Hz | −30.0 dB |

The teacher tracks its target closely (3.7 kHz vs 2.9 kHz roll-off, identical 6–8 kHz
level), which is the honest reading: **this is not a training bug.** The Edge book
render itself has almost no top octave, and the model faithfully learned that. The
problem is comparative — stock Kokoro carries a full top octave, so the teacher sounds
muffled beside it, and "clean" in the owner's vocabulary is partly just "bright".

**b) The teacher's harmonic series is irregular in a way the reference's is not.**

"Spectral ripple" = standard deviation of the long-term spectrum about a 200 Hz-smoothed
version of itself, 2–8 kHz. A clean voice is smooth; a buzzy or metallic one has
notches and spikes.

| Signal | ripple, 2–4 kHz | ripple, 4–8 kHz |
|---|---|---|
| Andrew reference | **1.35 dB** | **1.57 dB** |
| Stock Kokoro | 1.61 | 2.16 |
| Teacher (bundle render) | 2.40 | 2.82 |
| Teacher stage 2 (mine) | **2.78** | **3.24** |

The teacher is roughly **twice** as irregular as the audio it was trained on. See
`figures/fig2_harmonics.png` — a 320 ms window inside a vowel. The reference and stock
Kokoro have continuous horizontal harmonic bands; the teacher's bands are thin and
broken up, with the energy between harmonics behaving quite differently.

![Spectrograms](figures/fig1_spectrograms.png)
![Harmonic detail](figures/fig2_harmonics.png)

### Is the roughness the vocoder or the style vector?

This is the experiment that decides where to spend GPU hours. I captured `asr`, `F0`,
`N` and `ref_s` once from the base model and pushed **identical tensors** through three
different decoders, seeding the (stochastic) `randn` noise the same way each time.
Five different texts, so no single sentence decides it:

| Decoder (same inputs every row) | mean ripple |
|---|---|
| stock decoder | 1.98 dB |
| stage-1 decoder | 2.45 dB |
| **stage-2 decoder** | **2.92 dB** |

**The vocoder is the carrier.** Stage-2's decoder alone is 1.48× rougher than stock’s,
with the predictor and the style held fixed. In the full 2×2 (style × decoder):

| style pack | decoder | ripple |
|---|---|---|
| stock | stock | 2.01 |
| stock | **teacher** | 2.37 |
| **teacher** | stock | 1.76 |
| **teacher** | **teacher** | 2.86 |

The teacher *style vector* on a *stock decoder* is actually slightly **smoother**
(1.76). All the roughness arrives when the retrained decoder is in the loop. That is
consistent with a decoder that was unfrozen for a single epoch against a live
discriminator, with no time afterwards to settle — it learned a slightly irregular
spectral envelope and kept it.

---

## 3. Third finding: the style vector collapsed, and the pace got 15 % faster

Kokoro indexes its style pack by phoneme count: `pack[len(ps) - 1]`. A healthy pack is
**510 rows, each a different vector**, and the row *norm* falls steeply with length —
row 0 has norm 5.93, row 200 has norm 2.80.

Both exported packs have **one row, repeated 510 times**:

```
epoch_1st_00002_voice.pt   shape (510, 1, 256)   unique rows: 1   row-to-row L2: 0.0000
epoch_2nd_00002_voice.pt   shape (510, 1, 256)   unique rows: 1   row-to-row L2: 0.0000
am_michael (stock)         shape (510, 1, 256)   unique rows: 510 max|row0-rowN|: 1.165
```

The stage-1 pack is even degenerate in a second way: its first 128 dimensions and its
last 128 dimensions are *byte-identical* (max abs difference 0.0), i.e. the acoustic
and prosodic halves were never separated.

![Style pack structure](figures/fig5_stylepack.png)

### What that costs

Row choice changes duration, because the prosodic half of the vector feeds the
duration predictor. Holding the model fixed and changing *only* the pack:

| Model | pack | duration of the same 274-phoneme sentence |
|---|---|---|
| stock | proper 510-row pack | 18.85 s |
| stock | stock pack averaged into one row | **17.38 s** |
| stock | teacher pack (constant row) | **16.80 s** |
| stage-2 | proper 510-row pack | 18.15 s |
| stage-2 | teacher pack (constant row) | **16.30 s** |

**Collapsing the pack to one row costs 1.5 s of a 19 s sentence on its own** — about
8 % — before the model is even involved. The teacher's style vector, which has a
prosodic half that sits closer to the short-utterance end of the distribution, adds
another ~5 %. Net: the teacher reads the same text in **16.30 s where stock Kokoro
takes 18.85 s**, i.e. **2.82 words/s against 2.44**, a 15 % speed-up on a sentence
where the phoneme count is identical.

The same effect appears on an unrelated 106-phoneme sentence, so it is not
sentence-specific: stock model + stock pack 7.55 s → stock model + teacher pack 6.78 s
(−10 %), and stage-2 + teacher pack 6.83 s (−10 %).

That is a real, audible "why does this sound hurried / clipped" — and it is the kind
of thing that makes a listener say "it doesn't sound right" without being able to name
the problem, because every individual word is correct.

---

## 4. The 0.85× stretching: tested, and it is *not* the main cause

The obvious suspect was the tempo correction. I tested it directly: applied a
phase-vocoder speed-up (librosa) and `ffmpeg atempo=1.176` to the real Andrew clip and
measured what extra damage it does.

| variant | ripple 2–4 kHz | ripple 4–8 kHz | notch bins |
|---|---|---|---|
| original (0.85×, as trained on) | 1.35 | 1.57 | 20 |
| after phase-vocoder speed-up to 1.0× | 1.42 | 1.68 | 39 |
| after `ffmpeg atempo=1.176` | 1.40 | 1.59 | 28 |
| **teacher stage 2** | **2.78** | **3.24** | **393** |

The correction adds a *little* (about +0.05 dB of ripple) but it is an order of
magnitude smaller than the teacher's own defect. **Stretching is a contributing
nuisance, not the root cause.** It is worth avoiding on the next run because it is free
to avoid, but do not expect it to fix anything.

What *is* worth noting about the source data: it is 24 kHz mono, top of band rolled off
~45 dB by 10.5 kHz (`figures/fig3_gaps.png`), and the model inherited that ceiling
faithfully. If you want the teacher to sit next to stock Kokoro in a picker, the
training audio needs to be brighter than this book render.

---

## 5. Secondary observations, with honest confidence levels

**Confirmed:**

* **Late-render degeneration exists.** `teacher_long.wav` — 49 s, the longest teacher
  render in the bundle — ends with roughly 3 s of non-words. `small.en` transcribes the
  tail as literally `g g g g g g g g g g`; `base.en` hears `when turn up` then gives up.
  The frames are voiced (54 %), at 91.6 Hz, with normal flatness, so this is a coherent
  low-frequency babble, not noise: the classic signature of a duration/F0 predictor
  running out of conditioning. Two other samples show milder versions
  (`p_teacher_full`: ASR inserts a spurious `POLIT` mid-sentence).
  **But:** this sample is one of the hand-made renders, not a model property I could
  reproduce from a clean render of the same text — so treat "long-form drift" as
  *observed in the delivered artefact*, not yet as *attributed to the weights*.

* **`teacher_long.wav` is not the passage it is labelled with.** It is 49.17 s and its
  transcript is an entirely different story ("Chapter 1. The train was late…"). The
  file next to it, `logs/long_passage.txt`, is Dickens. So the long-form evidence file
  and its reference text do not match — worth fixing before anyone re-uses it.

* **Gap noise is a real differentiator.** In the silent gaps the teacher's mid-band
  (300–2000 Hz) sits at −36 to −44 dB relative to its own speech, against stock Kokoro's
  −19 to −31 dB — the teacher is *cleaner* between words than stock, but its gaps are
  not silent the way the reference's are either (`figures/fig3_gaps.png`). Listener-wise
  this reads as a faint room-tone hum rather than the digital black stock Kokoro gives.

**Measured but not significant:**

* **Jitter and shimmer are normal.** Praat local jitter 2.7 % / shimmer 10.2 % on the
  teacher vs 2.9 % / 11.1 % on stock and 2.4 % / 8.6 % on the reference. No micro-
  instability.
* **CPP (cepstral peak prominence) is normal-to-good**: teacher 2.3, reference 2.3,
  stock 1.6. By the standard clinical measure the teacher's voice is *cleaner* than
  stock Kokoro's.
* **Prosody is not flat.** F0 span over a 99 s passage: stock 13.5 semitones, teacher
  stage 2 14.6. If anything the teacher is more expressive.
* **No clipping, no DC offset, no clicks, no 80 Hz frame-rate buzz, and no comb
  filtering** — the notches move with the voice rather than sitting at fixed
  frequencies, so this is not a filter artefact.

This is the important negative result: **the defect is not a classic vocoder failure.**
It is a mild, broadband, spectral-envelope irregularity plus a dark top end plus a
15 %-fast read. Each is small; together they are what "weird quality issues" means.

---

## 6. Ranked root causes

| Rank | Cause | Confidence | Contribution |
|---|---|---|---|
| **1** | **Training is ~2 % of a normal budget, and the exported checkpoint is where the run stopped.** 3+3 epochs vs 200+100; decoder unfrozen 1 epoch; GAN live 1 epoch. | High — log arithmetic | Dominant |
| **2** | **Decoder retrained into a rougher spectral envelope**, measured with everything else held fixed (1.98 → 2.92 dB ripple, 5/5 texts). | High — controlled ablation | Dominant |
| **3** | **Style pack exported as one constant row** (510 identical rows) + degenerate stage-1 half-vectors. Costs ~8 % of duration on its own and removes all length-conditioned prosody. | High — file inspection + causal render | Large for pacing |
| 4 | **Dark top end inherited from the 0.85× book render** (99 % roll-off 2.9 kHz vs 6.9 kHz for stock). | High — measured | Large for "dull" |
| 5 | 0.85× → 1.0× tempo correction artefacts in the training target. | Medium — simulated, effect small | Small |
| 6 | Discriminator never separated real from generated audio in stage 1 (median disc loss 3.31 for all 1,227 steps); one aborted run produced a NaN-loss epoch that still saved weights. | High — logs | Means stage 1 mostly ran as plain mel regression |
| 7 | WavLM/SLM adversarial loss rose 55 % at GAN onset and never recovered (LM 0.831 → 1.284 → 1.301), which is a like-for-like measure. | High — logs | Contributes to instability |
| 8 | Long-form degradation / tail babble in the delivered artefact. | Medium — one sample, unreproduced | Unknown |

---

## 7. What I would do next, cheapest first

Costs assume one rented H100 at roughly $2–3/hr, batch 8, ~10 h of audio.

### Step 0 — free, do this first: pick a scorecard that can see the problem

Before spending anything, stop accepting UTMOS as the gate. It rated this teacher
*higher* than the human reference. For an audiobook narrator, gate on all of:

* **ECAPA ≥ 0.90** (likeness) — keep what you have;
* **WER ≤ 3 %** (intelligibility) — keep what you have;
* **spectral roll-off within 1.5 kHz of the target voice** (brightness) — new;
* **harmonic ripple in 2–8 kHz ≤ 1.3× the reference's** (smoothness) — new, and it is
  the one that catches this exact failure;
* **words/second within 5 % of the reference** (pacing) — new.

All five are cheap CPU measurements already written in `diagnosis/scripts/`.

> **A caveat on the scorecard itself:** my own numbers in this report are single-clip
> point measurements on CPU-python audio, not the scoring harness that produced the
> brief's 0.936 / 3.0 % / 4.46. Treat my absolute values as *relative* comparisons
> between renders made on the same machine, which is what they are, and re-run the
> brief's own harness for anything you gate on.

### Step 1 — retrain properly, decoder-frozen first (~4–6 GPU-hours)

Do not fine-tune the vocoder at all on the first attempt. This separates "is the
likeness in the predictor?" from "is the vocoder broken?", which is the question this
diagnosis could only answer by ablation.

```
stage 1:  freeze decoder, freeze text_encoder
          train bert, bert_encoder, predictor (+ style encoder)
          20-30 epochs, lr 1e-4
stage 2:  unfreeze decoder at joint_epoch, KEEP GAN OFF entirely
          10 epochs, lr 5e-5 for decoder via ft_lr, bert_lr 1e-5
          diff_epoch: 999 (as now — the diffusion head is not needed for a single speaker)
```

Expect ~12× the steps of the current run and roughly 4–6 GPU-hours at this corpus size.
If this already fixes the sound, you have learned the vocoder was never the problem and
you saved the expensive experiments.

### Step 2 — turn the GAN on properly, or not at all (~6–10 GPU-hours)

If step 1 is clean but a little "smooth/flat" (the usual symptom of mel-regression-only
training), then re-enable the discriminators — but for **at least 3–4 epochs**, at
`lambda_gen: 0.5`, with the GAN switched on *before* the last third of training. Watch
the discriminator loss: it should oscillate in the 0.7–1.4 range per head, not pin at
4.0. If it pins, the generator is not learning from it and you are only paying for the
damage it does to mel loss.

**Do not** simply extend the current recipe and hope. The current run's GAN was
net-negative over the only epoch it ran.

### Step 3 — rebuild the data, un-stretched (~2–4 hours of CPU, no GPU)

* **Do not tempo-correct.** If 0.85× is the only render you have, retrain on it at
  0.85× and apply the 1/0.85 speed factor at *inference* (`speed=` in Kokoro) — the
  model then never sees a stretched target. If Edge can re-render at 1.0×, do that.
* **Raise the bandwidth** if possible: the current target rolls off hard above
  10.5 kHz, and that is most of why the teacher sounds dull next to stock Kokoro.
* **Trim the tails.** Drop clips whose last 300 ms is below −40 dB or whose first
  300 ms is non-silent.
* Keep the train/val/OOD split as is — it is clean (9,983 clips, no leakage, OOD fully
  disjoint, 0 duplicate wavs or phoneme strings).

### Step 4 — export a proper style pack (~30 min, CPU)

The `voice.pt` must be 510 rows with real per-length variation. The two obvious ways
to get it:

1. **Best:** run StyleTTS2's own `extract_voicepack` over the training corpus and keep
   the per-length rows it produces (the log shows the trainer already doing exactly
   this for TensorBoard — see `extract_voicepack` references in `stage2.log`).
2. **Fast fallback:** keep the trainer's averaged 256-dim vector for timbre but graft
   the *row-shape* (row vector minus row mean) from a stock pack of the same gender.
   In this diagnosis that recovered 0.5 s of the 1.5 s the flat pack lost, so it is a
   patch, not a fix.

Then verify: `torch.unique(pack, dim=0)` should return 510 rows, and the row norms
should fall from ~5.9 at row 0 to ~2.8 by row 200.

### Step 5 — only if likeness is still short: decoder-only fine-tune (~10–15 GPU-hours)

If steps 1–3 give a clean voice that is only *partly* Andrew, that is the point at
which unfreezing the vocoder is worth the risk, because you will then be able to tell
whether a change helped. Do it at `ft_lr: 5e-5`, with the GAN on, for ≥5 epochs, against
a frozen, already-good predictor. This is the expensive experiment; the current run is
what it looks like when it is done first, for two epochs.

### Rough budget

| Path | GPU-hours | What you learn |
|---|---|---|
| Step 0 (scorecard) | 0 | Whether anything you ship next is actually better |
| Steps 1+3+4 (predictor-only, clean data, real pack) | 4–6 | Is the vocoder even involved? |
| Step 2 (proper GAN) | +6–10 | Does it need adversarial sharpening? |
| Step 5 (decoder fine-tune) | +10–15 | Can the vocoder carry the last few % of likeness? |
| **Total, if you go all the way** | **~20–30** | |

For scale: the run that produced this teacher used roughly **100 minutes** of GPU time
(19 min stage 1 + 83 min stage 2). That is the whole explanation.

---

## 8. One-paragraph answer for the owner

The teacher measures like Andrew because it *is* Andrew — the timbre, the words and the
pitch range are all correct, and ECAPA/WER only check those. What is wrong is that it
was trained for about an hour and exported while the last stage of training was still
shaking the audio: the vocoder came out slightly rough and dull, the voice's style data
was saved in a broken one-size-fits-all form, and the result reads about 15 % faster
than it should. None of that shows up in UTMOS, which is why the scorecard said 4.46
while Joel's ears said no. Fixing it is not a research problem — it is a matter of
training for the usual number of hours, keeping the vocoder frozen until the voice is
right, not pre-stretching the training audio, and exporting a proper style pack. The
cheapest useful next step is ~5 GPU-hours, not a rewrite.

---

## Files

| Path | What |
|---|---|
| `figures/fig1_spectrograms.png` | Same text, 7 s: reference / stock / teacher |
| `figures/fig2_harmonics.png` | 320 ms inside a vowel — harmonic band regularity |
| `figures/fig3_gaps.png` | Spectrum of the silences between words |
| `figures/fig4_waveform.png` | Waveform envelopes, same phrase |
| `figures/fig5_stylepack.png` | Stock 510-row pack vs the teacher's single row |
| `figures/fig6_teacher_long.png` | The 49 s render and where it degenerates |
| `figures/fig7_training.png` | Stage-2 losses, GAN onset, export point |
| `figures/fig8_stage1.png` | Stage-1 losses (1227 steps) |
| `audio/01..05` | Same sentence (01–04) + reference (05), loudness-matched |
| `audio/06..08` | **Decoder-only** isolation: identical inputs, three vocoders |
| `audio/09..10` | Short line: proper style pack vs collapsed pack |
| `scripts/` | Every measurement in this report, runnable on CPU |
| `REPRODUCING.md` | Exact environment and commands |

Audio clips are all normalised to −23 dBFS RMS so level is not the difference you hear.
