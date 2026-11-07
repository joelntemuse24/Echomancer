# Modal CPU worker. Build context is the repository root:
#   docker build -f workers/cpu/Dockerfile .
# This image is not built by tests. Whisper weights are not downloaded here.
# The first QA task on a container fetches the faster-whisper `base` model.

FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    python3 \
    python3-pip \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --break-system-packages "faster-whisper==1.1.1" "fastapi==0.115.6"

WORKDIR /opt/echomancer

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV CPU_RUNNER=local
ENV WORKER=1
ENV FFMPEG_PATH=/usr/bin/ffmpeg

CMD ["node", "--import", "tsx", "src/worker/cpu-once.ts"]
