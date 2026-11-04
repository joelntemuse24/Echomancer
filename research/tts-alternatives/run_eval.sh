set -e
S=/workspace/Echomancer/research
PY=/workspace/audio8-trial/.venv/bin/python
for m in chatterbox indextts ming; do
  $PY $S/audio8-quality/scripts/prosody_join_eval.py /workspace/tts-alternatives/vol/raw /workspace/tts-alternatives/vol/gen_$m.json /workspace/tts-alternatives/results/eval_$m
  $PY $S/tts-alternatives/fillers_tails.py /workspace/tts-alternatives/vol/raw /workspace/tts-alternatives/results/eval_$m/wav /workspace/tts-alternatives/vol/gen_$m.json /workspace/tts-alternatives/results/eval_$m/extras.json
done
echo ALLDONE
