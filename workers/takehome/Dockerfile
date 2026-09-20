# Always-on Whole-book worker. Optional — pm2 on the Oracle VM is the
# primary runbook (WORKER.md). Build from the repository root:
#   docker compose up -d
# Extract does not run in this image — that stays on Cloudflare Workers.

FROM node:22-bookworm-slim

# BuildKit sets TARGETARCH (amd64|arm64). Empty on old builders → amd64.
ARG TARGETARCH=amd64
# DeepFilterNet rust CLI 0.5.6 — not Python+torch.
# x86_64 musl pin matches trigger.config.ts. Ampere uses the gnu ARM binary.
ARG DEEP_FILTER_URL_AMD64=https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-x86_64-unknown-linux-musl
ARG DEEP_FILTER_SHA256_AMD64=70775e251eee44c0f2451a1e833326cf8bcbbe304d3e7cd12851e6fce72ef7da
ARG DEEP_FILTER_URL_ARM64=https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-aarch64-unknown-linux-gnu
ARG DEEP_FILTER_SHA256_ARM64=14e02a1c0028f3ca0bdf83b62b3336e56ba0556894ef295a95e8573f06557166

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    libatomic1 \
    wget \
  && if [ "${TARGETARCH}" = "arm64" ]; then \
       url="${DEEP_FILTER_URL_ARM64}"; sha="${DEEP_FILTER_SHA256_ARM64}"; \
     else \
       url="${DEEP_FILTER_URL_AMD64}"; sha="${DEEP_FILTER_SHA256_AMD64}"; \
     fi \
  && wget -q -O /usr/local/bin/deep-filter "${url}" \
  && echo "${sha}  /usr/local/bin/deep-filter" | sha256sum -c - \
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
