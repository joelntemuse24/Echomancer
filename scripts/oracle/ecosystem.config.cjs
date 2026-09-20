/**
 * pm2 app file for the Whole-book take-home worker.
 *
 *   pm2 start scripts/oracle/ecosystem.config.cjs
 *   pm2 save
 *
 * Secrets come from `.env.worker` via `src/worker/load-env.ts`.
 * This file only sets host-level knobs (loopback bind, WORKER=1).
 */
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");
const tsxBin = path.join(repoRoot, "node_modules/.bin/tsx");

module.exports = {
  apps: [
    {
      name: "echomancer-takehome",
      cwd: repoRoot,
      script: "src/worker/takehome-server.ts",
      interpreter: tsxBin,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 20,
      min_uptime: "10s",
      kill_timeout: 120000,
      listen_timeout: 10000,
      exp_backoff_restart_delay: 1000,
      time: true,
      env: {
        NODE_ENV: "production",
        WORKER: "1",
        WORKER_HOST: "127.0.0.1",
        WORKER_PORT: "8788",
        WORKER_ENV_FILE: path.join(repoRoot, ".env.worker"),
        TTS_MASTER_FULL_BOOK: "1",
        TTS_POLL_NUDGE_BUDGET_MS: "0",
        DEEP_FILTER_BIN:
          process.env.DEEP_FILTER_BIN || "/usr/local/bin/deep-filter",
      },
    },
  ],
};
