# Always-on Whole-book worker. Build from the repository root:
#   docker compose up -d
# Extract does not run in this image — that stays on Cloudflare Workers.

FROM node:22-bookworm-slim

ARG DEEP_FILTER_URL=https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-x86_64-unknown-linux-musl
# Same pin as trigger.config.ts — rust CLI, not Python+torch.
ARG DEEP_FILTER_SHA256=70775e251eee44c0f2451a1e833326cf8bcbbe304d3e7cd12851e6fce72ef7da

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    wget \
  && wget -q -O /usr/local/bin/deep-filter "${DEEP_FILTER_URL}" \
  && echo "${DEEP_FILTER_SHA256}  /usr/local/bin/deep-filter" | sha256sum -c - \
  && chmod +x /usr/local/bin/deep-filter \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 echomancer

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src

RUN chown -R echomancer:echomancer /app
USER echomancer

ENV NODE_ENV=production \
    WORKER=1 \
    WORKER_HOST=0.0.0.0 \
    WORKER_PORT=8788 \
    DEEP_FILTER_BIN=/usr/local/bin/deep-filter \
    TTS_MASTER_FULL_BOOK=1 \
    TTS_POLL_NUDGE_BUDGET_MS=0

EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8788/health || exit 1

CMD ["npx", "tsx", "src/worker/takehome-server.ts"]
