import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "proj_echomancer", // Replace with your Trigger.dev project ID
  runtime: "node",
  logLevel: "log",
  maxDuration: 1800, // 30 minutes
  dirs: ["./src/trigger"],
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 2,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
    },
  },
});
