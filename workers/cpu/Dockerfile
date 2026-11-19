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
#
# Do not assert pip's config lookup. That command does not read
# PIP_BREAK_SYSTEM_PACKAGES, and without its global-file flag it reads
# the user file rather than /etc/pip.conf. Bookworm pip 23.0.1 answers
# "No such key" for that lookup while a flagless
# `python3 -m pip install` of an installed pin succeeds. The build
# proves the install command Modal runs.

FROM node:22-bookworm-slim

COPY workers/cpu/requirements.txt /tmp/cpu-python-requirements.txt

ENV PIP_BREAK_SYSTEM_PACKAGES=1 \
    UV_BREAK_SYSTEM_PACKAGES=1

RUN printf '%s\n' '[global]' 'break-system-packages = true' > /etc/pip.conf

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    xz-utils \
    python3 \
    python3-pip \
    python-is-python3 \
  && rm -rf /var/lib/apt/lists/* \
  && find /usr -name EXTERNALLY-MANAGED -delete \
  && pip3 install --break-system-packages -r /tmp/cpu-python-requirements.txt \
  && ln -sfn /usr/bin/pip3 /usr/local/bin/pip \
  && python -VV \
  && python3 -c "import os, sysconfig; from pathlib import Path; marker = Path(sysconfig.get_path('stdlib')) / 'EXTERNALLY-MANAGED'; assert not marker.exists(), marker; assert os.environ['PIP_BREAK_SYSTEM_PACKAGES'] == '1'; assert os.environ['UV_BREAK_SYSTEM_PACKAGES'] == '1'; import requests; from faster_whisper import WhisperModel" \
  && python3 -m pip install --disable-pip-version-check --dry-run --no-index 'requests==2.34.2'

# Bookworm's ffmpeg is 5.1. Its linear loudnorm is wrong under about 3
# seconds. The short-clip path does not use that filter. Sections of 3
# seconds and longer still do, so the binaries on PATH are a pinned static
# GPL build (n8.1.3, libmp3lame included). Apt ffmpeg stays installed;
# only these two programs are replaced. PyAV keeps the apt libraries.
ARG FFMPEG_STATIC_URL=https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-11-18-12-39/ffmpeg-n8.1.3-36-ge22a4510c9-linux64-gpl-8.1.tar.xz
ARG FFMPEG_STATIC_SHA256=fce424851b0a982bdd4ac4e96f0e7b32cf29de999e54500676d41ad175ed0c79
RUN curl -fsSL -o /tmp/ffmpeg-static.tar.xz "$FFMPEG_STATIC_URL" \
  && echo "${FFMPEG_STATIC_SHA256}  /tmp/ffmpeg-static.tar.xz" | sha256sum -c - \
  && mkdir -p /tmp/ffmpeg-static \
  && tar -xJf /tmp/ffmpeg-static.tar.xz -C /tmp/ffmpeg-static \
  && install -m 755 /tmp/ffmpeg-static/*/bin/ffmpeg /usr/bin/ffmpeg \
  && install -m 755 /tmp/ffmpeg-static/*/bin/ffprobe /usr/bin/ffprobe \
  && rm -rf /tmp/ffmpeg-static /tmp/ffmpeg-static.tar.xz \
  && python3 -c "import re,subprocess; line=subprocess.check_output(['ffmpeg','-version'],text=True).splitlines()[0]; m=re.search(r'(\d+)\.(\d+)', line); assert m and (int(m.group(1)), int(m.group(2))) >= (6, 1), line"

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
