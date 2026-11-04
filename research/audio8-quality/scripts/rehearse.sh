#!/bin/bash
# CPU rehearsal for the whole plan. Runs each Modal job body against the real
# checkpoint with no GPU and no Modal credentials, so any wiring mistake shows up
# here instead of in a paid container.
#
#   ./scripts/rehearse.sh /path/to/local/checkpoint [outdir]
#
# The checkpoint dir needs config.json, model.safetensors, codec.pth,
# tokenizer.json and the four *.py/*.json files from the HF repo
# (Edge0/Audio8-TTS-Realistic-Air). See README.md for the one-liner that builds
# it with `hf download`.
#
# On 4 CPU threads each stage takes minutes: generation runs at RTF ~3.5, so a
# 27 s take is about 95 s. The script is deliberately short (1 text, 1 seed, 2
# alphas, 2 LoRA steps) so the whole rehearsal is under an hour and proves the
# plumbing rather than the science.
set -euo pipefail

MODEL="${1:?usage: rehearse.sh <local-checkpoint-dir> [outdir]}"
OUT="${2:-$(dirname "$0")/../out-rehearsal}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
LIBRISPEECH="${A8Q_LIBRISPEECH:-}"

python3 "$HERE/scripts/selftest.py" --model "$MODEL"

echo "=== baseline"
python3 "$HERE/scripts/local_run.py" baseline --model "$MODEL" --short --seeds 1234 --out "$OUT"

echo "=== steer (1 text, alphas 0 and 0.75)"
python3 "$HERE/scripts/local_run.py" steer --model "$MODEL" --short --seeds 1234 \
  --alphas 0,0.75 --out "$OUT"

echo "=== codec (no fine-tune)"
python3 "$HERE/scripts/local_run.py" codec --model "$MODEL" --short --out "$OUT"

if [ -n "$LIBRISPEECH" ]; then
  echo "=== dataset prep (20 clips)"
  python3 "$HERE/scripts/local_run.py" prep --librispeech "$LIBRISPEECH" --limit-clips 20 --out "$OUT"

  echo "=== lora (2 steps, eval on 1 text)"
  python3 "$HERE/scripts/local_run.py" lora --model "$MODEL" --short --steps 2 \
    --dataset "$OUT/prep/dataset" --out "$OUT"
else
  echo "=== skipping prep + lora (set A8Q_LIBRISPEECH=/path/with/LibriSpeech)"
fi

echo "=== eval on everything written so far"
python3 "$HERE/scripts/local_run.py" eval --short --wav "$OUT/steer/wav" --out "$OUT"

echo "written to $OUT"
find "$OUT" -name metrics.json | sort
