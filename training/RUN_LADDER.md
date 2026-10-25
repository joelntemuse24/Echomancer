# Rebuild Echomancer Andrew at a bigger preset

The v1.1 voice is four trained stages, not one. This document is the exact
sequence, with the arguments that produced the shipped model, and a preset swap
for a larger student.

Baseline (shipped): `s+mlp` text side + decoder `A` + head `v2` = 8.7M params.
Target: `l` text side + decoder `L` + head `v2`, roughly 25-30M params.

Everything below assumes the working directory is `training/` with `data/teacher/`
holding the shards.

## 0. Prerequisites

```bash
# Python 3.12 required: kokoro declares <3.13
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python torch torchaudio
uv pip install --python .venv/bin/python \
  "transformers==5.17.0" "kokoro==0.9.4" "misaki==0.9.4" espeakng-loader \
  soundfile jiwer matplotlib onnx onnxruntime huggingface_hub datasets \
  "numpy==2.5.3" "spacy==3.8.16" "srsly==2.5.3" thinc blis
```

Dataset: 7 shards, 2.3 GB, at `data/teacher/shard_0000.pt` … `shard_0006.pt`.
They are also in R2 at `paradee-dataset/teacher/`.

## 1. Text side

```bash
# Baseline used s+mlp at 8,000 steps. Presets: xxs, xs, s, s+mlp, m, l
uv run python scripts/train_text.py l --steps 8000 --device cuda --eval-every 0
```

Resumable: rerunning continues from `checkpoints/text_l/last.pt`.

## 2. Decoder, three runs

```bash
# 2a. spectrogram losses, 50,000 steps
uv run python scripts/train_decoder.py L --steps 50000 --device cuda --eval-every 0

# 2b. adversarial, mel weight 10x
uv run python scripts/train_decoder.py L --gan --mel-weight 10 \
  --init-from checkpoints/dec_L/last.pt --steps 5000 --bs 8 \
  --device cuda --eval-every 0 --tag _gan10

# 2c. adversarial, mel weight 3x
uv run python scripts/train_decoder.py L --gan --mel-weight 3 \
  --init-from checkpoints/dec_L_gan10/last.pt --steps 5000 --bs 8 --shards 8 \
  --device cuda --eval-every 0 --tag _gan3
```

## 3. The v1.1 head

```bash
X=(--head v2 --fine-stft --harm-weight 2 --mod-weight 5 --shards 999 --utmos)

# 3a. spectrogram + harmonic/modulation statistics, 40,000 steps
uv run python scripts/train_vhead.py $X --steps 40000 --eval-every 0 \
  --device cuda --trunk checkpoints/dec_L_gan3/last.pt --tag 2_full

# 3b. adversarial, mel weight 3x, 15,000 steps
uv run python scripts/train_vhead.py $X --gan --mel-weight 3 --bs 8 \
  --init-from checkpoints/vh2_full/last.pt --steps 15000 \
  --device cuda --eval-every 0 \
  --trunk checkpoints/dec_L_gan3/last.pt --tag 2_fullgan
```

`--harm-weight` matches how much energy sits on multiples of the pitch per band.
`--mod-weight` matches how upper-band loudness pulses with the pitch. Both matter:
spectrogram losses alone leave upper harmonics too clean, which sounds buzzy.

`--trunk` must point at the stage-2c decoder. The default is `dec_A_gan3`, which
is the baseline, so passing it explicitly is required for a bigger preset.

## 4. Export and score

```bash
uv run python scripts/export_paradee_v1_1.py checkpoints/vh2_fullgan/last.pt

# Objective comparison against the 3.478 baseline and 4.435 Edge Andrew
uv run python scripts/utmos.py out/
uv run python scripts/wer.py out/
uv run python scripts/rtf.py l L --dec-tag _gan3   # speed on one CPU thread
```

`eval_full.py l L --dec-tag _gan3` writes listening WAVs for student vs teacher.

## The voice question — settle this first

`scripts/gen_teacher.py` line 11 loads `pipe.load_voice("af_heart")`, a female
Kokoro voice. But the audio inside `data/teacher/shard_0000.pt` measures 111 Hz
median F0, which is male. Those contradict.

Before spending GPU time, confirm which voice the corpus holds:

```bash
uv run python -c "
import torch, numpy as np
rows = torch.load('data/teacher/shard_0000.pt', map_location='cpu', weights_only=False)
a = rows[0]['audio'].float().numpy() / 32767
print('peak', np.abs(a).max(), 'rms', np.sqrt((a**2).mean()))
print('text:', rows[0]['text'][:100])
"
```

If the corpus is male, `gen_teacher.py` in this repo is not what produced it, and
the modified generator needs finding before any retraining — otherwise the new
student learns from a corpus whose voice differs from the shipped model's.

## Time and cost

| Stage | Steps | A10 (0.37 s/step) | H100 (0.16 s/step) |
|---|---|---|---|
| Text `l` | 8,000 | 49 min | 21 min |
| Decoder `L` | 50,000 | 5.1 h | 2.2 h |
| Decoder GAN | 10,000 | 1.0 h | 27 min |
| vhead | 40,000 | 4.1 h | 1.8 h |
| vhead GAN | 15,000 | 1.5 h | 41 min |
| **Total** | 123,000 | **~12 h** | **~5.3 h** |

At Modal rates: A10 $1.10/h → **~$13**; H100 $3.95/h → **~$21**.

To fit a smaller budget, cut decoder 2a to 25,000 steps and vhead 3a to 20,000 —
about half the cost, with some quality loss in the generator stages.

## Failure modes seen already

- **Periodic eval OOMs the GPU.** `train_text.py` and `train_decoder.py` load the
  82M Kokoro teacher mid-run. `--eval-every 0` defers that to the final step.
  Checkpoints save every 500 steps, so a crash still leaves a resumable state.
- **Preset `l` alone is not a model.** Training only the text side and
  synthesising through Kokoro's frozen decoder produces a different speaker.
  All four stages must run.
- **Do not use `af_heart`'s style vector for student inference.** `student.py`
  learns its own `self.style` parameter; substituting the teacher's pack changes
  the voice identity entirely.
