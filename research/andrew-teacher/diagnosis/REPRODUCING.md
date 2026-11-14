# How this analysis was run

Everything here ran on the 4-vCPU CPU-only VM. No GPU, no Modal, no deployment.

## Setup

```bash
python3 -m venv /tmp/kokoro-env
/tmp/kokoro-env/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
/tmp/kokoro-env/bin/pip install "kokoro==0.9.4" "misaki[en]" numpy scipy soundfile \
    matplotlib librosa praat-parselmouth torchaudio faster-whisper onnxruntime
```

Weights and base model:

```bash
# teacher checkpoints (release asset, ~327 MB each, CPU-loadable)
gh release download andrew-teacher-evidence-2026-11-14 -R joelntemuse24/Echomancer \
    -D /tmp/andrew-weights

# base Kokoro at the exact revision the teacher was fine-tuned from
python -c "
from huggingface_hub import hf_hub_download
for f in ['kokoro-v1_0.pth','config.json']:
    print(hf_hub_download('hexgrad/Kokoro-82M', f,
        revision='f3ff3571791e39611d31c381e3a41a3af07b4987'))"
```

Scores:

* **UTMOS22 strong learner** — `tarepan/SpeechMOS` release checkpoint, loaded through
  `speechmos.utmos22.strong.model.UTMOS22Strong` (this is the MOS predictor whose
  ~4.46 number the brief quotes). Checkpoint is 28 MB and runs on CPU.
* **SQUIM** (`torchaudio.pipelines.SQUIM_OBJECTIVE`) — reference-free PESQ/STOI/SI-SDR.
* **DNSMOS P.835** (`speechmos.dnsmos`) — OVRL/SIG/BAK.
* **Praat** (`parselmouth`) — harmonics-to-noise ratio, jitter, shimmer, F0.
* **faster-whisper** `base.en` + `small.en` — WER, word timings, pacing.

## The control that matters: holding everything fixed except one module

`kh.py` builds a fresh base Kokoro and copies only chosen module groups out of a
teacher checkpoint, so an ablation changes exactly one thing:

```python
build(groups=('decoder',), src='s2')   # base model, stage-2 decoder only
```

`decoder_ab.py` then runs the base model's own forward path and *captures*
`asr`, `F0`, `N` and `ref_s`, so the same tensors can be pushed through each
candidate decoder. Durations, pitch contour and style are therefore byte-identical
between the decoders being compared.

Note: Kokoro's `Generator` adds `torch.randn_like` noise (see `istftnet.py`), so the
decoder is **stochastic**. Every comparison seeds `torch.manual_seed(0)` first.

## Reproducing the headline numbers

```bash
cd research/andrew-teacher/diagnosis/scripts
python robust.py          # decoder-only spectral ripple across 5 texts
python attribution.py     # 2x2 style x decoder decomposition
python bandwidth.py       # brightness ceiling of each signal
python darkness.py        # which half of the style vector is dull
python pack_len.py        # constant style row vs length-indexed rows
python gan_effect.py      # parses stage2.log; GAN onset effect
python trainfig.py        # fig7 + fig8
python cpp.py             # CPP / HNR / F0 perturbation
```

Set `PYTHONPATH=/tmp/SpeechMOS` for anything importing `utmos.py`.
