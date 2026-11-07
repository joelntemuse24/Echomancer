# Modal CPU worker. Build context is the repository root:
#   docker build -f workers/cpu/Dockerfile .
# This image is not built by tests. Whisper weights are not downloaded here.
# The first QA task on a container fetches the faster-whisper `base` model.
#
# One interpreter. `python` and `pip` on PATH are the apt packages (Debian
# does not ship those names). Modal learns the version with `python -VV`,
# then adds layers that invoke that same interpreter with no PEP 668 flag:
#
#   RUN python -m pip install 'fastapi[standard]==0.115.6'
#
# Image builder 2024.10 also runs `uv pip install --system` for the client
# requirements. `--system` targets this apt interpreter, not a venv that
# happens to be first on PATH, and uv does not read pip.conf. Do not
# create a virtualenv in this image and do not pass add_python: both split
# the interpreter that section QA pins with TTS_QA_WHISPER_PYTHON.
#
# This container is the only user of its Python, so the Debian
# externally-managed marker is removed and both installers are told to
# proceed. That applies to every later `python -m pip` and `uv pip
# --system` layer, not only the FastAPI one.

FROM node:22-bookworm-slim

COPY workers/cpu/requirements.txt /tmp/cpu-python-requirements.txt

ENV PIP_BREAK_SYSTEM_PACKAGES=1 \
    UV_BREAK_SYSTEM_PACKAGES=1

RUN printf '%s\n' '[global]' 'break-system-packages = true' > /etc/pip.conf

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    python3 \
    python3-pip \
    python-is-python3 \
  && rm -rf /var/lib/apt/lists/* \
  && find /usr -name EXTERNALLY-MANAGED -delete \
  && pip3 install --break-system-packages -r /tmp/cpu-python-requirements.txt \
  && ln -sfn /usr/bin/pip3 /usr/local/bin/pip \
  && python -VV \
  && python3 -c "import os, sysconfig; from pathlib import Path; marker = Path(sysconfig.get_path('stdlib')) / 'EXTERNALLY-MANAGED'; assert not marker.exists(), marker; assert os.environ['PIP_BREAK_SYSTEM_PACKAGES'] == '1'; assert os.environ['UV_BREAK_SYSTEM_PACKAGES'] == '1'; import requests; from faster_whisper import WhisperModel" \
  && python3 -m pip config get global.break-system-packages | grep -qx true

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
