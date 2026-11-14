# Andrew clarity — why step150 is not as clean as real Edge Andrew

Research note, November 2026. Draft; nothing here is merged or in a production path.

Subject: the fine-tuned Kokoro-82M `Andrew` voice at `test2b` step 150. The product owner
reports, side by side with the real Microsoft Edge `en-US-AndrewNeural` reading, "slight
slurring, buzziness at the ends of some sentences, and generally less clarity". His guess
is that the fit to Kokoro is the limit.

**Short version.** He is close, but the failure is not where the brief assumed. Fricatives
are being *partly voiced*: on 41% of the frames where real Edge has a fricative, step150
comes back periodic, and its fricative-to-vowel high-band ratio is otherwise normal. The
consonant is still in the right place at the right level; it has the wrong voicing. That
one failure explains all three complaints — a half-voiced `/s/` sounds slurred, reads as
`/z/`, and at a phrase end is a steady tone instead of a hiss, which is the buzz.

The high band is not the problem, and the premise "it is much darker than real Andrew:
roll99 1711 vs 2531 Hz" does not survive a mask-free measurement. On an energy-weighted
spectrum step150 has *more* 6.5-9 kHz energy than the reference, its 3.5-8 kHz energy sits
where Edge puts it to within 0.01 dB, and the shipped `roll99` gate is being moved by a
2.9 dB shelf in the 80-200 Hz band. The brightness gate was measuring the low end.

There is a second, independent cause: both step150 and the stock render with a clean pack
sit 2.6-4.0 dB down at 800-1800 Hz where a stock trained pack does not. That is a
band-limited tilt from the style pack the training produced, not from the decoder and not
from the source audio.

The training objective cannot see either problem. Scored against real Edge on the same
text, a *stock* Kokoro render with a clean low-likeness pack scores 1.80 on step150's own
mel-L1 loss against step150's 1.53 — the objective barely distinguishes "slightly wrong
Andrew" from "not Andrew", so it has almost no gradient towards what the listener hears.

The cost ceiling is not the constraint. Measured from the step150 run log, an L4 does
0.686 s/step, so the remaining $6.80 buys about **4.8 hours and 25,000 steps**. Three
proposed stages cost $0.65 and 35 minutes between them. The money should go on the
objective and the data, not on more steps of the current recipe — which is exactly what
happened when the run was extended to step 800 and got worse.

---

## 1. What was measured, and how

Everything below is reproducible from the archive:

```bash
python3 research/andrew_clarity/analyze_samples.py \
  --dir /path/to/samples \
  --passage /path/to/passage_text.txt \
  --pack /path/to/ckpt/test2b/step00150_voice.pt      # optional ablation
python3 -m pytest research/andrew_clarity -q          # 46 tests, no fixtures needed
```

The analysis uses four signals: `07` real Edge Andrew at 1x, `09` step150 at speed 0.85,
`03` the old over-trained teacher, `02` stock Kokoro with the low-likeness pack. It adds a
fifth by rendering the step150 style pack on **stock** Kokoro weights
(`pack_on_stock.py`), which is the only ablation the archive allows and the one that
separates "the fine-tune did this" from "the style vector did this".

Three measurement decisions matter, and each of them changed a conclusion:

1. **No frame-percentile speech mask for spectra.** The shipped `gate.py` helpers select
   frames above the 60th percentile of frame energy. That is not neutral: a take with more
   silence than its neighbour is scored on a different subset of frames. §4 shows what it
   costs.
2. **Voicing decided by autocorrelation, not by a pitch tracker.** A frame is aperiodic
   when its normalised autocorrelation peak over lags of 60-350 Hz is below 0.45. Calibrated
   on synthetic signals: a two-harmonic vowel gives 0.74, white noise 0.10.
3. **Level-matched on an anchor band, never on total RMS.** All cross-system band
   comparisons normalise on 300-3000 Hz. Without that, 09 being 3.4 dB quieter than 07
   reads as a spectral difference.

---

## 2. The ranked causes

### 1. Fricatives are being *partly voiced* — the dominant cause

This is the one that matters. Take the reference's aperiodic frames, warp the candidate
onto them by DTW, and ask what the candidate is doing there. The candidate's periodicity
distribution at those frames:

| system | p10 | p25 | p50 | p75 | p90 | fraction > 0.45 (voiced) |
|---|---|---|---|---|---|---|
| 07 real Edge | 0.135 | 0.179 | **0.253** | 0.345 | 0.412 | **0.000** |
| **09 step150** | 0.153 | 0.192 | **0.363** | 0.540 | 0.614 | **0.414** |
| 03 old teacher | 0.157 | 0.188 | 0.251 | 0.362 | 0.464 | 0.130 |
| 02 stock + cma pack | 0.153 | 0.199 | 0.289 | 0.430 | 0.499 | 0.207 |
| pack-on-stock | 0.151 | 0.200 | 0.322 | 0.449 | 0.530 | 0.248 |

Real Edge's fricatives are *never* periodic (0.000 above threshold). In step150 **41% of
the frames where Edge has a fricative come back periodic**, and the median periodicity
rises from 0.253 to 0.363. Dropping the fine-tune and keeping only the style vector gets
that back to 25%, so roughly half the leak is the pack and half is the predictor and
decoder fine-tune. The old teacher, for all its roughness, leaked only 13%.

This is not a missing consonant, and that distinction is the whole diagnosis. Two checks
confirm the consonant is still there spectrally, just the wrong *kind*:

* **The high band is in the right place.** 09 puts 3.5-8 kHz energy where Edge has
  fricatives to within 0.01 dB of the reference's own share (-0.48 vs -0.49 dB of its
  total), and its fricative-to-vowel high-band ratio is +12.04 dB against the reference's
  +11.13. So the top band has not been filtered away and has not moved onto the vowels.
  The brief's "weak 6-8 kHz energy" is, if anything, slightly the opposite.
* **The events are still in the right slots.** Onset recall is 0.87, the same as a stock
  pack, and pace is 3.07 words/s against 3.13.

What has gone wrong is the *voicing distinction*. A fricative with voicing bled into it is
a different phoneme: `/s/` becomes `/z/`, `/f/` becomes `/v/`, `/p/` becomes `/b/`. The
listener does not hear a missing sound, they hear the boundary between the consonant and
the vowel dissolve — "slurring". And a partially-voiced fricative at the end of a phrase
is a steady tone rather than a hiss, which is the "buzz".

15 of the reference's 50 aperiodic events stay under 20% retention and 16 clear 80%, so the
leak is uneven rather than uniform; the worst single event is a 192 ms run at 13.4 s. Median
retention across the 50 is 0.55. Scattered across the passage is why it reads as general
slurring rather than as mangled words.

**Why the mechanism is plausible from the code.** `SineGen` in `istftnet.py` builds its
harmonic source from a hard voicing decision, `uv = (f0 > 10)`, and adds a fixed 0.003
noise floor to voiced frames. There is no separate voicing head and no place where a
fricative's voicelessness is represented except through F0. The F0 targets the predictor is
trained against come from `jdc`, which is trained on *mel* frames and produces a smoothed
contour: at a 40 ms fricative the target F0 does not fall to zero, because the contour is
interpolated across it. A model fitted to that contour has no reason to emit `uv = 0`, so
the harmonic source keeps running through the consonant. That is exactly the measured
signature — partial voicing, correct spectrum, correct timing.

### 2. The style pack carries a band-limited tilt (800-1800 Hz down, 2-8 kHz up)

Energy share per band, energy-weighted, relative to real Edge:

| band | 07 | **09 step150** | stock `am_michael` | stock + step150 pack | 02 stock+cma |
|---|---|---|---|---|---|
| 300-500 | 0.00 | -0.88 | +1.48 | -0.41 | -0.91 |
| 500-800 | 0.00 | -1.24 | -0.31 | -0.98 | -1.51 |
| **800-1200** | 0.00 | **-3.95** | -0.15 | **-3.74** | **-3.83** |
| **1200-1800** | 0.00 | **-3.45** | -0.96 | **-2.45** | **-2.53** |
| 1800-2500 | 0.00 | -0.93 | +3.40 | +0.30 | +1.65 |
| 3500-8000 | 0.00 | +0.52 | +7.19 | +4.61 | +6.25 |

The 800-1800 Hz dip is present in every render that uses a computed pack and absent from a
stock trained pack (`am_michael`, -0.15 / -0.96). That band holds F1 and the lower half of
F2 — the region that carries vowel identity and, more to the point here, the locus
transitions that tell a listener which consonant just happened. A 3-4 dB notch there is
audible as hollowness even when everything else is right.

The pack is also unusually structured for a voice: per-dimension standard deviation across
its 510 rows is 0.063 against 0.025-0.044 for the stock packs, and its row-to-row step is
2.1x `am_michael`'s. Cosine similarity to `am_michael` sits at 0.59 for both halves. This
is a pack doing real work rather than nudging a base, which is consistent with it also
carrying the tilt.

Smoothing the pack along its length axis does **not** create the dip (tested at 18, 32, 64
and 128 knots on `am_michael`); it is a property of what the pack learned, not of the
`Pack` class's 18-knot interpolation. That rules out the cheapest suspected mechanism and
narrows the fix to what the pack is fitted against.

Above 2 kHz both candidate and pack-on-stock run **above** the reference (+0.5 to +3.9 dB
for 09 at 6.5-8.5 kHz, +5 to +7 for pack-on-stock). This is the opposite of "weak 6-8 kHz
energy". It is excess, and it is harmonic: splitting 4-8 kHz into the part within
±0.2·F0 of an integer harmonic and the part between harmonics gives a
harmonic-to-inter-harmonic ratio of -0.05 dB for step150 against -0.03 dB for the
reference — identical. So this is not added noise or buzz, it is the voice being slightly
brighter than the reference in the top octaves. Worth correcting, not worth ranking above
the voicing failure.

### 3. The generator never returns to silence, and the release tail is the wrong shape

| system | gap SNR p5 (dB) | peak | crest | tail periodicity, last 250 ms |
|---|---|---|---|---|
| 07 real Edge | **81.7** | 0.675 | 16.7 | 0.241 |
| **09 step150** | **68.8** | 0.448 | 16.6 | **0.299** |
| 02 stock + cma | 60.3 | 0.674 | 17.1 | 0.440 |
| pack-on-stock | 54.2 | 0.351 | — | 0.296 |

step150 has 12.9 dB less dynamic range than the reference: its quietest frames do not fall
as far. Two details say this is the generator rather than the level setting:

* crest factor is identical (16.6 vs 16.7 dB), so it is not compression;
* the last 120 ms of the file sits at -45.7 dBFS with a zero-crossing rate of 0.093,
  against -38.5 dBFS and 0.231 for the reference. The reference ends on breath; step150
  ends on a low-frequency residue.

And the tail is *more* periodic than the reference (0.299 vs 0.241): the phrase-end vowel is
held as a tone instead of decaying into noise. That is the "buzz at the ends of some
sentences" the listener described, and it is the same failure as cause 1 seen in the time
domain — a fricative-free release.

**It is not what the brief suspected.** Phrase-final F0 does not misbehave: the median F0
on the last 250 ms is 77.8 Hz for step150 against 88.7 Hz for the reference, and the
declination over a sentence is 8.6 semitones against 10.0 — *less* fall, not a broken one.
Nor does F0 drop out: 0.00% of step150's speech frames are below 70 Hz, against 1.89% for
the reference. The iSTFT decoder is not producing artefacts; the source is wrong before the
decoder sees it.

### 4. The objective cannot see the difference the listener hears

This is the reason the run could not have fixed any of the above, and it is a cause in its
own right.

Scored against real Edge on the same text, after DTW warping, using the exact three-branch
`MelLoss` from `train.py`:

| system | 1024/600 | 2048/1200 | 512/240 | mean |
|---|---|---|---|---|
| 03 old teacher | 1.1445 | 1.1443 | 1.2694 | **1.1861** |
| 09 step150 | 1.4948 | 1.5577 | 1.5397 | **1.5307** |
| 02 stock + cma pack | 1.7799 | 1.8805 | 1.7343 | **1.7982** |

The objective that produced step150 scores a stock render with a *low-likeness* pack at
1.80 against step150's 1.53 — the gap between step150 and the reference (1.53, or 0.34 of
the total range) is hardly larger than the gap between step150 and a voice that is not
Andrew at all (0.27). An objective in which "slightly wrong Andrew" and "not Andrew" are
that close has almost no signal to descend. Log-mel L1 is dominated by the 0-1 kHz bands
(30% of the loss lives below 1 kHz, 15% in 5-8 kHz) and it is phase-blind, so a smeared
consonant and a clean one at the same envelope are the same number.

The finer resolution matters: the mel front ends in `train.py` use a 240-sample hop at their
finest, i.e. 10 ms, which cannot resolve a 20 ms plosive burst. `MelLoss`'s finest branch is
1024/120/600 — a 600-sample window at 24 kHz is 25 ms, longer than the events being lost.

### 5. The 96 kbps source audio is *not* the cause

Tested directly: re-encode real Edge Andrew to 96 kbps and to 48 kbps MP3, decode, and
compare band by band against the original.

| re-encode | worst band change |
|---|---|
| 96 kbps | **0.06 dB** (7.5-8.5 kHz) |
| 48 kbps | 0.88 dB (6.5-7.5 kHz) |

At 96 kbps the source codec moves nothing that matters. Even 48 kbps — half the bitrate —
costs less than 1 dB. Whatever is wrong with step150, it is not the training data's
container. This hypothesis can be retired.

### 6. Duration and F0 prediction are fine — a non-cause worth recording

Pace is close (3.07 vs 3.13 words/s on the trimmed span) and within-sentence speech rate is
4.02 vs 4.45 words/s. F0 range is slightly narrow (IQR 6.0 semitones vs 6.5) but no
population is missing. Onsets survive DTW at 87% (vs 87% for the stock pack), so the timing
grid is not the problem: 09 has the consonants in roughly the right places and has stopped
pronouncing them. Keep the pace and F0 gates; they are not where the loss is.

---

## 3. Why "darker" was the wrong reading

The brief's headline measurement is `roll99` 1711 Hz (it measures 1699 on the file
supplied; the difference is the frame mask) versus 2531 Hz. The number is real. The
interpretation is not.

`roll99` is the frequency below which 99% of the spectral energy lies, and it is computed
on frames above an energy percentile. On a logarithmic frequency axis most of the bins sit
below 1 kHz, so the upper 1% of total energy can be dominated by a shift of a couple of dB
at 80-300 Hz. `hi_band` is worse: it is literally (6-8 kHz) / (100-300 Hz), so adding bass
moves it directly.

Measured, on the reference itself, changing nothing above 1 kHz:

| change to real Edge | shift in `roll99` | shift in `hi_band` |
|---|---|---|
| +1 dB below 200 Hz | -82 Hz | -2.02 dB |
| +3 dB below 200 Hz | **-164 Hz** | **-3.34 dB** |
| +6 dB below 200 Hz | -270 Hz | -5.49 dB |
| -3 dB below 200 Hz | +94 Hz | +1.64 dB |

The observed difference between 09 and 07 is -188 Hz and -1.14 dB. A +3 dB low shelf on the
reference reproduces the `roll99` gap almost exactly while doing nothing at all to the top
band. And the actual measured difference in the 80-200 Hz band between 09 and 07 is
**+2.87 dB**.

Two further checks on the same question:

* Mask-free, energy-weighted LTAS: 09 is +1.4 to +5.5 dB **above** the reference from 5.5
  to 9 kHz, and `roll99` measured this way is 4336 Hz for 09 against 4078 Hz for 07.
* Splitting 4-8 kHz energy into harmonic (within ±0.2·F0 of a multiple of F0) and
  inter-harmonic parts on voiced frames: harmonic-to-inter-harmonic ratio is -0.05 dB for
  07 and -0.05 dB for 09, i.e. identical. There is no buzz in the sense of an added
  inharmonic tone at the top.

So the gate is measuring the low end, and the low end is where the difference is. **The
brightness gates need to be replaced, not tuned** — see §5.

A caveat on the `rolloff` sweep, because it is the strongest evidence for that claim: with
the frame percentile at 20 or 40 the *ordering flips* and `roll99` prefers 09 over 07. A
gate whose verdict depends on an arbitrary percentile cannot rank candidates, and it should
not have been the thing a run was steered by.

---

## 4. The style pack, in detail

The pack is `(510, 1, 256)`: `pack[phoneme_count - 1]`, rows `[:128]` into the decoder,
rows `[128:]` into the predictor. Measured properties:

| pack | mean row norm | std across rows (per dim) | median distance from the mean row | row-to-row step |
|---|---|---|---|---|
| `am_michael` (stock) | 2.888 | 0.0346 | 0.390 | 0.0115 |
| `am_adam` (stock) | 2.547 | 0.0292 | 0.341 | 0.0098 |
| `bm_george` (stock) | 3.256 | 0.0250 | 0.307 | 0.0085 |
| `af_heart` (stock) | 2.388 | 0.0436 | 0.452 | 0.0171 |
| **step150** | 2.986 | **0.0632** | **0.809** | **0.0247** |

step150's rows are twice as far from their own mean as any stock pack's, and move twice as
fast between adjacent lengths. It is a strongly *prosodic* pack rather than a timbre
constant. That is the "the style pack may be averaging over prosody" hypothesis in the
brief, and the shape of the numbers supports it — but the consequence is not averaging, it
is that one 256-vector per phoneme-count has to carry both the voice and the contour, and
the measurement shows the contour winning at 800-1800 Hz.

The 18-knot `Pack` parameterisation in `rt_common.py` restricts the correction to a
smooth function of length, so the pack is smoother than a freely-fitted one would be. That
is not the cause of the dip (tested: smoothing `am_michael` to 18 knots moves 800-1200 Hz
by +1.3 dB rather than -3.7), but it does mean the model cannot represent a length-specific
timbre change, which is a separate limitation to be aware of before blaming the pack for
everything.

---

## 5. Proposed work

Three things, in order of expected value per dollar. The code for all of it is in this
directory and tested; the Modal app is `modal_clarity.py`.

### 5.1 Replace the objective (`losses.py`)

Four terms added to the existing mel loss. Every one is level-invariant and none needs a
discriminator.

| term | what it fixes | why it is safe at this budget |
|---|---|---|
| `mr_stft_loss` | phase-blindness; multi-resolution spectral convergence + log-magnitude at 512/1024/2048, the 512 window being 21 ms so it can see a plosive | deterministic, no second network, no training instability |
| `high_band_loss` | the 6-8 kHz balance, matched against a **1-4 kHz** anchor so a low-end shelf cannot move it | a ratio, so a gain change cancels |
| `voicing_balance_loss` | cause 1 directly: matches the share of 3.5-8 kHz energy that is spectrally flat, i.e. how much of the top band is frication | a statistic, not a per-sample target — a different but plausible fricative still scores well |
| `silence_floor_loss` | cause 3: compares the candidate's quiet frames to the target's, only where the target is quiet | cannot be satisfied by turning the take down |

**On the GAN question in the brief.** Do not reintroduce the discriminator yet. The
evidence against it is in the project's own history: the old teacher reached ECAPA 0.919 and
sounded rough, and step150's ripple climbs monotonically from 1.12 at step 75 to 1.74 at
step 750 as the decoder frees up — that is a GAN-shaped failure mode arriving without a
GAN. `training/scripts/discriminators.py` exists and works (`d_loss`, `g_loss`,
feature matching), and `training/README.md` records that spectrogram losses alone leave the
upper harmonics too clean. So the argument for adversarial training is real; it is just
second in line. Multi-resolution STFT supplies the same high-band pressure with a loss that
cannot diverge, which matters when there is $6.80 and one shot per stage. If stage B clears
`consonant_retention` but still sounds synthetic, add a period discriminator frozen at low
weight in a *fourth* stage — not before.

**On the source data.** Not the problem (§2.5), so do not spend the budget collecting more.
But two data notes are worth carrying forward: the F0 targets are `jdc` predictions from a
*mel* front end built with `torchaudio.transforms.MelSpectrogram(n_mels=80, n_fft=2048,
win_length=1200, hop_length=300)` and **no `sample_rate` argument**, which defaults to
16 kHz. The filterbank is therefore stretched over the real 24 kHz signal: its top bin
really sits at 11.6 kHz, not 7.7 kHz, and its lowest 20 bins cover 0-970 Hz where they were
meant to cover 0-640. The voiced/unvoiced cue the generator keys off comes from that
front end. It is not obviously the cause of anything measured here, but it is a real
misconfiguration in the target pipeline and it belongs on the list before the next run.

### 5.2 Add clarity gates beside the existing five (`clarity_gate.py`)

The existing gates stay. These are added, and the brightness pair is retired or fixed:

| gate | 07 real Edge | 09 step150 | target |
|---|---|---|---|
| `consonant_retention` | 1.000 | **0.586** | ≥ 0.90 |
| `onset_recall` | 1.000 | 0.870 | ≥ 0.95 |
| `hf_balance_db` | 0.000 | +2.17 | −1.0 … +1.0 |
| `hf_from_noise` | 0.877 | 0.869 | ≥ 0.85 (but only once retention is up) |
| `gap_snr_p5` | 81.7 | **68.8** | ≥ 75 |
| `tail_periodicity` | 0.241 | **0.299** | ≤ 0.26 |
| `env_modulation` | 21.3 | 17.9 | ≥ 20 |

`consonant_retention` is the primary gate: it is the one metric that tracks all three
listener complaints, it separates the four systems in the right order (07 1.00 > 03 0.87 >
pack-on-stock 0.75 > 09 0.59), and it is what the new loss terms are aimed at. A candidate
that does not clear it should not be promoted however good its ECAPA likeness is — that is
precisely the trade the old teacher made.

Read it as a *graded* number, not a pass/fail. 0.586 means 59% of Edge's fricative frames
are still aperiodic in the candidate; because the failure is partial voicing rather than
deletion, a candidate at 0.75 is audibly better than one at 0.59 without being fixed, and
the thresholds below are calibrated on one passage (§6).

`hf_from_noise` is deliberately *not* a standalone target. It is 0.87 for 09 and 0.88 for
the reference even though 09 has lost most of its consonant voicing, because the metric is a
share of a band that stays in roughly the right place. It only becomes informative once
`consonant_retention` is fixed, which is the opposite of the obvious reading.

**Retire `roll99` and `hi_band` as acceptance criteria, or fix them.** They are not
measuring brightness (§3). If a single-number brightness gate is wanted, use the
energy-weighted LTAS `roll99` from `analyze_samples.py` §3 — 4336 Hz for 09 against 4078 for
07, which at least points the right way — and always level-match on 1-4 kHz.

### 5.3 The run (`plan.py`, `modal_clarity.py`)

| stage | init | decoder | steps | objective | purpose |
|---|---|---|---|---|---|
| **A** | phase-1 best (`test/best_*)` | **frozen, bit-identical to stock** | 900 | clarity weights on | loss-only ablation: can this 82M decoder make clean consonants at all? |
| **B** | A's winner | 10x-lower LR, L2 pull 5e-4 | 1200 | clarity, decoder terms raised | fix the tilt and the gap floor if A says the decoder is the limit |
| **C** | B's winner | lower LR, stronger pull | 600 | `w_silence`/`w_voice` raised | phrase-end repair only; skip if A and B clear the gate |

Stage A is the important one and the cheapest. It starts from the checkpoint whose likeness
is already 0.78 with the decoder untouched, so any movement in the gate is attributable to
the objective. If A cannot lift `consonant_retention` above 0.8 with a stock decoder, the
answer to the product owner's question is yes — Kokoro's decoder is the limit — and stage B
should not be run at all. That decision is worth $0.22.

Cost, from the measured 0.686 s/step and 3 s/score at $1.12/h:

```
$ python3 research/andrew_clarity/plan.py
spendable $5.35 of $6.80 (reserve $1.20, prep $0.25)

  A_clarity_frozen        900 steps   706 s  $0.22
  B_clarity_unfreeze     1200 steps   912 s  $0.28
  C_endings               600 steps   483 s  $0.15

  total 35 min  $0.65  leaves $4.70
```

`plan.py` refuses to truncate a stage mid-schedule: a stage cut short has a different LR
curve and is not the experiment it claims to be, so it drops whole stages and says which.
The $1.20 reserve exists so the stage that comes closest can be re-run with adjusted
weights, which is where the marginal dollar is worth most.

### Commands

```bash
# 0. Free: confirm the timings and the stage costs still hold.
python3 research/andrew_clarity/plan.py --budget 6.80

# 1. Stage A, 900 steps, 12 minutes, $0.22.
modal run research/andrew_clarity/modal_clarity.py::stage --stage A_clarity_frozen --hours 0.5

# 2. Score A's output on the held-out passage and compare with 09.
#    (on the VM, where the reference renders already live)
python3 research/andrew_clarity/analyze_samples.py --dir samples --passage passage_text.txt

# 3. Only if consonant_retention >= 0.8 and hf_balance_db is still outside +-1:
modal run research/andrew_clarity/modal_clarity.py::stage --stage B_clarity_unfreeze --hours 0.5

# 4. Only if the endings are still wrong:
modal run research/andrew_clarity/modal_clarity.py::stage --stage C_endings --hours 0.5
```

Each stage writes `clarity_*` keys into its own `hist.json` next to the existing
`ecapa_*` / `ripple` / `roll99` / `wps`, so a checkpoint is judged on one render.

---

## 6. What could not be verified

Stated plainly, because each of these weakens a claim above.

1. **No Modal credentials and no 313 MB checkpoint.** No stage has been run. The costs are
   a model built from the measured step time in `test2b/run.log`, not from a fresh run;
   the clarity weights in `plan.py` are reasoned from the measurements, not tuned.
2. **The checkpoint's predictor and decoder weights were unavailable**, so I could not
   render step150 directly and had to analyse the supplied MP3. That is fine for the
   spectral and voicing findings — the decode is 24 kHz mono at 128 kbps, and §2.5 shows
   what a 96 kbps pass does — but it means the per-phoneme analysis is on a lossy decode.
3. **The pack-on-stock ablation is not the checkpoint.** It isolates the style vector from
   the fine-tuned predictor and decoder, which is what §2.2 needs, but it cannot separate
   "predictor fine-tune" from "decoder fine-tune". Only a stage-A render can do that.
4. **The five-point reference numbers in the brief (ECAPA 0.783, ripple 1.21, wps 2.77) do
   not reproduce on the supplied files** (this analysis: `roll99` 1512 not 1711, `ripple`
   1.54 not 1.21, wps 3.07 not 2.77). The samples may be a different render or a different
   passage segment. Every comparison here is *within* the supplied set, so the ranking
   stands, but the absolute values should not be mixed with the earlier report.
5. **ECAPA was not run.** `speechbrain` is not installed in this environment and the likeness
   figure is not needed for any conclusion — it is quoted from the brief. Installing it and
   re-running is a five-minute job for whoever has the checkpoint.
6. **One passage.** Four systems, one held-out paragraph, three sentences. The consonant
   loss is scattered across 50 events rather than clustered, which suggests it generalises,
   but the gate thresholds in §5.2 are calibrated on this single passage and should be
   re-derived on a second one before they gate a real decision.
7. **The `sample_rate` bug in `rt_common.norm_mel`** is confirmed by inspection and by the
   filterbank geometry, but I could not measure its effect on the F0 targets without the
   dataset.
8. **Not tested at all: whether the proposed losses actually improve the gate.** That is
   stage A. Everything above is diagnosis; this is the experiment.

---

## 7. Appendix — gate definitions

```
consonant_retention   mean over the reference's aperiodic frames of
                      [candidate periodicity at the DTW-matched frame < 0.45]
onset_recall          fraction of the reference's 500-4000 Hz envelope onsets (top 5% of
                      frame-to-frame rises) whose matched candidate frame is also above
                      its own 80th percentile of rises
hf_balance_db         mean over {3.5-5.5, 5.5-8} kHz of
                      (candidate band - anchor) - (reference band - anchor), anchor 300-3000 Hz,
                      speech frames only, where speech = within 35 dB of the 95th percentile frame
hf_from_noise         sum of candidate 3.5-8 kHz energy on aperiodic frames / total
gap_snr_p5            p90(frame level dB) - p5(frame level dB)
tail_periodicity      median over phrases of median periodicity in the last 250 ms
env_modulation        std over speech frames of 20*log10(500-4000 Hz frame energy)
```

`aperiodic` = speech frame whose normalised autocorrelation peak over lags 60-350 Hz is
below 0.45. Calibration: two-harmonic synthetic vowel 0.74, white noise 0.10.

Files:

```
clarity_gate.py        the gates and their definitions
analyze_samples.py     reproduces every number in this document
losses.py              the four objective terms
train_clarity.py       rebinds train2.step_losses; does not fork the trainer
plan.py                the cost model and the stage definitions
modal_clarity.py       modal run only; never deployed
pack_on_stock.py       the style-vector ablation
test_*.py              46 tests, no fixtures in git
```

Run the tests with `python3 -m pytest research/andrew_clarity -q`. They need `numpy`,
`scipy`, `librosa` and `torch` (CPU is fine) and nothing else; `.github/workflows/
clarity-tests.yml` runs them on every push that touches this directory.
