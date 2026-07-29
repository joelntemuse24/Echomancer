/**
 * Vitest setup, applied before any module in a test file is imported.
 *
 * Several modules read configuration at import time (`STORAGE_ROOT`, R2
 * credentials, the Turso URL), so the environment has to be in place before the
 * first import rather than inside a `beforeEach`.
 *
 * Tests run against a real in-memory libSQL database and a real temp directory
 * so route handlers exercise the production code paths — only the upstream TTS
 * provider is faked.
 */

import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

process.env.TURSO_DATABASE_URL = ":memory:";
delete process.env.TURSO_AUTH_TOKEN;

// A fixed key keeps signed session tokens reproducible across a test file.
process.env.SESSION_SECRET = "test-session-secret";
process.env.INTERNAL_JOB_SECRET = "test-internal-secret";
process.env.CRON_SECRET = "test-cron-secret";

// No R2 credentials → the storage layer uses this directory.
delete process.env.R2_ACCOUNT_ID;
delete process.env.R2_ACCESS_KEY_ID;
delete process.env.R2_SECRET_ACCESS_KEY;
process.env.STORAGE_PATH = mkdtempSync(path.join(tmpdir(), "echomancer-test-"));

// Never let a test accidentally reach OpenRouter.
delete process.env.OPENROUTER_API_KEY;

// Polling paths must not synthesize during tests; workers are driven explicitly.
process.env.TTS_POLL_NUDGE_BUDGET_MS = "0";
process.env.TTS_RETRY_BACKOFF_MS = "0";
process.env.PREMIUM_HD_ENABLED = "false";
delete process.env.PREMIUM_HD_ALLOWLIST;
