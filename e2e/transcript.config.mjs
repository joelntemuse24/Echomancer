import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
export default defineConfig({
  testDir: ".", testMatch: "transcript.spec.ts",
  tsconfig: "../tsconfig.json",
  use: { baseURL: "http://127.0.0.1:4174", browserName: "chromium", channel: process.env.PLAYWRIGHT_CHANNEL },
  timeout: 30_000,
  webServer: {
    command: "node e2e/transcript-harness-server.mjs",
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    url: "http://127.0.0.1:4174",
  },
});
