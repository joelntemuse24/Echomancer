# Modal CPU worker. Build context is the repository root:
#   docker build -f workers/cpu/Dockerfile .
# This image is not built by tests. Whisper weights are not downloaded here.
# The first QA task on a container fetches the faster-whisper `base` model.
#
# Modal's Function runtime runs `python -VV` and expects `python` and `pip`
# on PATH. Debian's python3 packages do not provide those names, so this
# image adds them as links to the same interpreter. Do not also pass
# Image.from_dockerfile(add_python=...): that copies a second Python onto
# /usr/local and `python3` would no longer be the one with faster-whisper.
# The FastAPI package for the web endpoint is installed by Modal onto its
# own image interpreter (see modal/cpu_worker.py). It is not this apt install.

FROM node:22-bookworm-slim

COPY workers/cpu/requirements.txt /tmp/cpu-python-requirements.txt

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    python3 \
    python3-pip \
    python-is-python3 \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --break-system-packages -r /tmp/cpu-python-requirements.txt \
  && ln -sfn /usr/bin/pip3 /usr/local/bin/pip \
  && python -VV \
  && python3 -c "import requests; from faster_whisper import WhisperModel"

WORKDIR /opt/echomancer

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV CPU_RUNNER=local
ENV WORKER=1
ENV FFMPEG_PATH=/usr/bin/ffmpeg
# Whisper must keep using apt python3 even if a later layer puts another
# interpreter earlier on PATH.
ENV TTS_QA_WHISPER_PYTHON=/usr/bin/python3

CMD ["node", "--import", "tsx", "src/worker/cpu-once.ts"]
