import { defineConfig } from "@trigger.dev/sdk";

/**
 * Trigger.dev Cloud runs Whole-book generation off Vercel.
 * Set TRIGGER_PROJECT_ID to the project ref from the Trigger dashboard
 * (proj_…). TRIGGER_SECRET_KEY must match on Vercel and in Trigger.
 */
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_ID || "proj_echomancer",
  runtime: "node",
  logLevel: "log",
  maxDuration: 3600,
  dirs: ["./src/trigger"],
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 30_000,
      factor: 2,
      randomize: true,
    },
  },
});
