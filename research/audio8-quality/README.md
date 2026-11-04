# Audio8 quality: breaths and codec ticks

Two audible defects in `Edge0/Audio8-TTS-Realistic-Air` (0.6B, Apache 2.0), and the
model-level fixes for them:

1. **Breaths.** The model breathes in the pauses it creates: a soft "ahh" after a
   sentence, an inhale before the next, roughly 33-44 auditable candidates per two
   pages at -62 to -70 dBFS with vowel-shaped formants near 1, 1.8, 2.4 and 3.5 kHz.
2. **Ticks.** Short high-frequency ticks, 5-12 kHz at about -42 dBFS, repeating every
   46-51 ms in pauses and quiet passages.

Trimming, gating and decode-time token bans were all tried before this folder and all
were judged band-aids. This folder finds the cause inside the model and removes it
there.

Nothing here is imported by the app. No worker, route or TTS provider is modified.

---

## What the CPU work already established

Run on a 4-vCPU box against the real 0.6B checkpoint, with the same code the GPU jobs
use. Reproduce any of it with `scripts/rehearse.sh` (see below).

### The codec is not the source of the ticks

The earlier trial attributed the ticks to "the codec decode". Decoding the *same
decoder* on two kinds of latent says otherwise. These are real numbers from the CPU
rehearsal (`results/cpu-rehearsal.json`), 12 s takes, bf16 model, fp32 codec:

| Latents handed to the decoder | 5-14 kHz crest in quiet frames | frame RMS |
|---|---|---|
| the encoder's own **digital-silence** latents (34 distinct frames) | **-88.3 dBFS** | -97.1 |
| the model's **pause** latents, voice 1 | **-51.4 dBFS** | -64.0 |
| the model's **pause** latents, voice 2 | **-59.8 dBFS** | -59.7 |

Same weights, same code path, 37 dB apart. The decoder is clean when it is handed
silence; it ticks when it is handed the latents the model chose for the pause. So the
tick is *content the AR asked for*, not a decoder defect, and it is louder for one
reference voice than the other because the pause frames themselves differ.

`audio8q.codec_tools.causality_report` repeats this per run and prints one of three
verdicts. `modal_baseline.py` records it for both voices; on voice 1 it returns
`latent-defect: the decoder is clean on silence latents; the model's pause latents
carry the HF content`.

### Both defects are one defect

A breathy latent is unvoiced, mid-band, formant-shaped audio. The codec reproduces it
one 46.4 ms frame at a time, so its HF frication is re-excited at exactly the codec
frame rate. That is why the "ticks" repeat every 46-51 ms, why they live in pauses,
why they are loudest for the brightest reference voice, and why removing 14
breath-correlated codebook-0 tokens halved both numbers at once. The tick is the
breath's top end.

So the thing to fix is the decision the slow AR makes when it enters a pause. That
decision is a single token from a 155k-way LM head, and the state that makes it is
available before the choice is taken.

### The breath direction is strongly separable

Capturing the LM head's input for every generated frame, then labelling those frames
from the decoded audio (`audio8q.steering.label_frames`), one contrast direction
separates breathy frames from clean pauses with a separation of **2.8 standard
deviations**, and **61% of breathy frames** sit above the threshold that only 2.9% of
clean pauses cross. That is the direction activation steering uses.

### Activation steering works, and the first operating point was too weak

Measured on the CPU rehearsal: two passages, two voices, alpha 0.75 against the same
seed, four takes per voice.

| Voice | | breath candidates | audible | pause "ahh" | ticks | ticks / pause-min | quiet HF crest |
|---|---|---|---|---|---|---|---|
| 1272 | baseline | 18.0 | 9.0 | 9.0 | 4.5 | 47.5 | -40.4 dBFS |
| 1272 | clamp 0.75 | 19.5 | 7.5 | 7.5 | 2.0 | **21.9** | -36.3 dBFS |
| 3536 | baseline | 21.0 | 6.0 | 5.0 | 1.0 | 27.5 | -40.5 dBFS |
| 3536 | clamp 0.75 | 14.5 | 8.5 | 6.5 | 0.5 | **11.7** | -40.3 dBFS |

The clamp cut ticks per pause-minute by 54% and 57% on the two voices, and pause
"ahh"s by 17% and -30%. It did **not** reach the targets on breaths, and it is frankly
inconsistent: on voice 1 it raised the total candidate count while lowering the audible
count, and on voice 2 the audible count went the wrong way. The sweep in
`modal_steer.py` therefore covers alpha up to 2.5 and also reports blanket projection,
which the CPU probe showed can drive quiet-frame HF from -37 to **-79 dBFS**.

Two things this establishes, and one it does not.

* It establishes that **the direction is real and the hook is safe**. No take lost a
  word; the speech is unchanged; the artifact moves. The token ban that reached a
  similar breath reduction cost 140 deleted words on one seed.
* It establishes that **a single fixed alpha on one direction will not be enough**, and
  that a per-voice difference exists. Voice 2 breathes less and the clamp already helps
  it; voice 1 breathes twice as much and the clamp mostly relocates the breaths.
* It does **not** establish that steering is sufficient. If alpha 2.5 and projection
  both miss, the LoRA (job 5) is the remaining model-level option, and the codec pair
  fine-tune (job 3) is the decode-side one.

The quiet HF crest moving *up* on voice 1 (-40.4 to -36.3) while ticks per minute fell
is the clearest single sign that alpha 0.75 is underpowered: the clamp is weakening the
breath latents without removing them, which makes fewer but slightly sharper bursts.
That is exactly the behaviour a stronger clamp or a projection should fix, and exactly
why the metric set reports both.

---

## Layout

```
audio8q/
  frames.py        codec frame grid (2048 samples, 46.44 ms) + frame features
  probes.py        breath detector, tick detector, HF-burst-per-frame measure
  codec_tools.py   decoder-vs-latent causality test, pause-frame substitution
  steering.py      frame labelling, contrast direction, clamp/project hooks
  train_lora.py    LoRA injection, teacher-forced loss, merge, KV-cache detach
  dataprep.py      LibriSpeech -> breath-free corpus (noise-floor replacement)
  evalharness.py   per-take metrics, WER, speaker similarity, accept/reject
  jobs.py          the four experiment bodies (no Modal import)
  refs.py          the two committed reference voices
  texts.py         the four committed public-domain passages
modal_baseline.py  job 1: characterise the model, run the codec causality test
modal_steer.py     job 2: learn the breath direction, sweep steering strength
modal_codec.py     job 3: codec diagnosis + short decoder fine-tune
modal_prep.py      job 4: build the breath-free corpus (CPU only)
modal_lora.py      job 5: LoRA the slow AR (only if steering is not enough)
modal_eval.py      job 6: WER + speaker similarity + the pass/fail decision
scripts/
  selftest.py      12 checks, 11 of them need no checkpoint
  local_run.py     run any job body on CPU against a real checkpoint
  rehearse.sh      the whole plan on CPU, in order
refs/              2 LibriSpeech clips (CC-BY 4.0) + exact transcripts
```

Volume layout, all under `audio8-trial-vol:/audio8-quality/`:

```
baseline/metrics.json          job 1
steer/metrics.json             job 2   + breath_direction.npy
codec/metrics.json             job 3   + decoder_lite.pt
dataset/dataset/manifest.json  job 4   + wav/
lora/metrics.json              job 5   + lora_state.pt
eval/metrics.json              job 6   the file that decides pass/fail
```

Every job also writes its takes as `wav/{variant}__{text}__s{seed}__{ref}.wav`, so
`modal_eval.py` needs no index and any take can be pulled back by name.

---

## Run order and cost

Six jobs. Each is `modal run` from the repo root, each stops its own container
(`scaledown_window=5`, `max_containers=1`), each writes JSON to the Volume and returns
a small summary. Prices are Modal list from the earlier trial: **L4 $0.000222/s**
($0.80/h), A10G the same class, CPU $0.0000131 per physical core per second.

| # | Command | Hardware | Wall | Cost |
|---|---|---|---|---|
| 1 | `modal run research/audio8-quality/modal_baseline.py` | 1x L4 (A10G fallback) | ~10 min | **~$0.14** |
| 2 | `modal run research/audio8-quality/modal_steer.py` | 1x L4 | ~15 min | **~$0.20** |
| 3 | `modal run research/audio8-quality/modal_codec.py` | 1x L4 | ~8 min | **~$0.12** |
| 4 | `modal run research/audio8-quality/modal_prep.py` | 4 CPU cores | ~25 min | **~$0.03** |
| 5 | `modal run research/audio8-quality/modal_lora.py --steps 600` | 1x L4 | ~20 min | **~$0.30** |
| 6 | `modal run research/audio8-quality/modal_eval.py --runs baseline,steer,codec,lora` | 4 CPU cores | ~12 min | **~$0.05** |

Total worst case **$0.84**, plus first-build image time. Run 1-3 and 6 first: if
steering reaches the targets, skip 4 and 5 entirely, and the bill is about $0.50.

Add `--limit-texts 2` to any GPU job for a cheap smoke pass at roughly half the cost
before committing to the full matrix.

### Run this order

```bash
# 0. optional but recommended on a new machine: prove the wiring on CPU first
python3 -m pip install torch==2.8.0 transformers==4.57.3 soundfile "numpy<2" \
  scipy librosa faster-whisper jiwer whisper-normalizer speechbrain pyloudnorm
hf download Edge0/Audio8-TTS-Realistic-Air --local-dir /tmp/audio8
cd research/audio8-quality && ./scripts/rehearse.sh /tmp/audio8 && cd -

# 1. characterise the stock model + settle the codec question
modal run research/audio8-quality/modal_baseline.py

# 2. steering sweep (the primary fix)
modal run research/audio8-quality/modal_steer.py

# 3. codec diagnosis, and the decoder fine-tune in the same run
modal run research/audio8-quality/modal_codec.py --steps 300

# 4. breath-free corpus (only needed for job 5)
modal run research/audio8-quality/modal_prep.py

# 5. LoRA fallback (only if job 2 or 3 misses the targets)
modal run research/audio8-quality/modal_lora.py --steps 600

# 6. score everything
modal run research/audio8-quality/modal_eval.py --runs baseline,steer,codec,lora
```

Send back `audio8-quality/{baseline,steer,codec,eval}/metrics.json` after each job
(and `lora/metrics.json` after job 5). They are small. Pull the audio with:

```bash
modal volume get audio8-trial-vol audio8-quality/steer/wav ./steer-wav
modal volume get audio8-trial-vol audio8-quality/eval/metrics.json ./eval-metrics.json
```

---

## What decides success

Measured per take, then averaged per variant by `evalharness.compare`, against the
same four passages and two reference voices as the baseline:

| Metric | Target | Why this number |
|---|---|---|
| `breath_candidates` | **<= 0.5x baseline** | the token ban reached ~0.55x and Joel could still hear them, so half is the floor, not the goal |
| `pause_ah` | **<= 1 per take** | the trial's banB got 0-1 per 27-line set; that is the level at which the "ahh" stopped being reliably audible |
| `ticks_per_pause_minute` | **<= 2** | baseline measures 37 and the trial's post-fix takes measured 3-7 with a weaker detector; <=2 is clean by any detector |
| `wer` | **<= 3%** | faster-whisper `small.en` normalised; baseline sits at 1.5-2.5%, and the banned-token run that lost 140 words measured 15% |
| `speaker_similarity` | **no worse than -0.02** | ECAPA cosine to the reference clip; baseline 0.83-0.85, and the reference-quality gate already treats a 0.02 drop as audible |

`evalharness.TARGETS` holds these values and `compare()` marks each one pass or fail,
so the gate is in code rather than in a paragraph.

Two numbers are reported but do not gate. `hf_frames_per_pause_minute` counts quiet
frames that still carry 5-14 kHz energy; it is the frame-periodic view of the tick
problem and the least sensitive to detector tuning, so it is the tie-breaker when
`ticks_per_pause_minute` is noisy on a short take. `voiced_8_12k_vs_1_4k_db` is the
take's brightness, which explains why the artifact was louder on one voice.

---

## Why steering, and when to stop steering

Steering is the primary fix because it changes the decision rather than the output:
the model stops choosing breathy latents in pauses, so there is no gated silence, no
trimmed tail, and no token to ban. It costs one hook and one numpy vector, needs no
retraining, and reverts by removing the hook.

The LoRA is the fallback for the case steering cannot reach: if the contrast direction
stops separating at some alpha, or if the alpha needed to hit the target starts moving
speech. Watch two things in `steer/metrics.json`:

* `direction.above_threshold_fraction_negative` should stay small. If it climbs, the
  clamp is starting to act on clean pauses and speech.
* `by_variant.<alpha>.wer` must stay at baseline. The banned-token experiment is the
  cautionary case: suppression that looks good on breath counts and drops words is
  worse than breaths.

The LoRA trains on breath-free speech (`dataprep.py`) with the fast AR, codec and text
embeddings frozen, so it cannot drift toward the training speakers as fast as a full
fine-tune, and `lora_state.pt` is a few MB. The risks the earlier write-up named -
flatter prosody, weaker cloning, gated-sounding silences - are exactly what the eval
measures, which is why job 5 is gated behind jobs 1-3 and 6.

---

## Reproducing the detectors

`scripts/selftest.py` is 12 checks: 11 need no checkpoint and run in two seconds, the
twelfth loads the model and pins the things that only break in a container (hook
firing per frame, hidden width, frame/token alignment, LoRA gradients, and the KV
cache that `generate()` leaves behind and that breaks a following training forward
pass).

```bash
python3 scripts/selftest.py                 # 11/11
python3 scripts/selftest.py --model /tmp/audio8   # 12/12
```

The detectors are calibrated on signals whose answer is known: a -70 dBFS noise floor
with a 24-sample 8 kHz burst every codec frame reports 43 ticks, 45 ms spacing and 1.0
frame periodicity; the same floor without bursts and the codec's own silence latents
both report 0. Both breath detectors are level-relative so one threshold set works for
a loud and a quiet voice.

One caveat worth stating plainly: **a raw recording is not a valid negative control
for the tick detector.** Clean LibriSpeech narration contains real breaths whose HF
crest lands in the same band and the same pause frames. That is the whole point of the
finding above - breaths and ticks are the same energy - and it is why the detector
reports burst spacing and width alongside the count.

---

## Not done here

The production worker is untouched by design. If a fix is accepted, the follow-up is a
small change in whichever inference path ships: attach the hook in the AR step loop, or
load the decoder state dict for the codec variant, and nothing about chunking, leases
or storage changes.
