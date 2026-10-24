# Paradee TTS sidecar

`server.py` is a small Python stdlib HTTP service around the Paradee v1.1 fp32
ONNX voice model. It keeps a pool of warm worker processes, synthesizes at
24 kHz mono, and returns MP3 (128 kbps) or WAV (16-bit PCM).

- `GET /health` → `{"ok":true,"procs":N}`
- `POST /synthesize` with `{"text": "...", "speed": 1.0, "format": "mp3"}`
  → `audio/mpeg` or `audio/wav`, plus an `X-Audio-Seconds` header
- Env: `PARADEE_HOST` (127.0.0.1), `PARADEE_PORT` (8791),
  `PARADEE_MODEL`, `PARADEE_CONFIG`, `PARADEE_PROCS` (3),
  `PARADEE_SECRET` (optional; requires `Authorization: Bearer <secret>` on POST)

## Install on the VPS

The model files live outside git, on the server.

```sh
sudo mkdir -p /opt/echomancer/paradee
sudo chown -R "$USER": /opt/echomancer/paradee

python3 -m venv /opt/echomancer/paradee/venv
/opt/echomancer/paradee/venv/bin/pip install -U pip
/opt/echomancer/paradee/venv/bin/pip install -r scripts/paradee/requirements.txt
/opt/echomancer/paradee/venv/bin/pip install "git+https://github.com/sahilmahendrakar/paradee"
/opt/echomancer/paradee/venv/bin/python -m spacy download en_core_web_sm

# ffmpeg is required for MP3 encoding
sudo apt-get install -y ffmpeg
```

Model and config:

- `paradee.onnx` — the fp32 polished student, from the Modal volume
  `andrew-distill`, path
  `/kokoro/edge/student_model/paradee_v1.1_polish/paradee.onnx`.
  Place it at `/opt/echomancer/paradee/paradee_v1.1_polish_fp32.onnx`.
- `config.json` — from Hugging Face `sahilmahendrakar/Paradee-8M-v1.1`,
  revision `v1.1`. Place it at `/opt/echomancer/paradee/config.json`.

Neither file is committed to this repo.

Notes: int8 quantization of the fine-tuned student audibly degrades it (the
reference samples were rendered from the fp32 graph), and fp32 is also faster
on the Contabo CPU (~21x vs ~17x realtime per thread). MP3 is 128 kbps because
64 kbps smeared high frequencies before mastering.

## Narration shaping

`plan_chunks` lays out model calls, `trim_padding` removes the silence the
graph puts around every call, and `_synth` joins the takes back with explicit
gaps. A paragraph is offered to the model as **one call** whenever its
phonemes fit `MAX_PHONEMES` (510), because the model then plans intonation
across the whole paragraph. Reading one sentence per call produced a
330/810 ms alternating pause, a comma-flattened sentence end, and 18.2 s of
audio for a paragraph that takes 15.7 s as one call. A paragraph that does not
fit is packed into as few calls as the graph allows, and a stub final call
absorbs a sentence from its neighbour so the decoder never restarts on one
short phrase.

Tuning knobs (all module constants): `LEAD_SILENCE_KEEP_MS` /
`TAIL_SILENCE_KEEP_MS` (40 / 90 ms), `SENTENCE_GAP_MS` (300), and
`PARAGRAPH_GAP_MS` (620). `ROOM_TONE_DBFS` (-72) lays a seeded dither bed
under the take so pauses are not digital zeros. Raising `MAX_CALL_GAIN` (1.35)
or `ROOM_TONE_DBFS` is a way to make one paragraph pump against the next or to
add audible hiss.

Tests: `python -m unittest discover -s scripts/paradee -p 'test_*.py'` (the
model is faked, so it runs anywhere).

## Run

```sh
pm2 start /opt/echomancer/paradee/venv/bin/python --name echomancer-paradee -- scripts/paradee/server.py
pm2 save
```

Quick check: `curl -s http://127.0.0.1:8791/health`
