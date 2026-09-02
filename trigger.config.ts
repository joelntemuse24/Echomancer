import { additionalPackages } from "@trigger.dev/build/extensions/core";
import { defineConfig } from "@trigger.dev/sdk";

/**
 * Trigger.dev Cloud runs Whole-book generation off Vercel.
 * Set TRIGGER_PROJECT_ID to the project ref from the Trigger dashboard
 * (proj_…). TRIGGER_SECRET_KEY must match on Vercel and in Trigger.
 *
 * Indexing imports takehome.ts → @libsql/client → libsql, which does
 * require(`@libsql/${currentTarget()}`). On Cloud (Linux x64 glibc) that
 * is @libsql/linux-x64-gnu — an optionalDependency, not a static import —
 * so additionalPackages must install it into the worker image.
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
  build: {
    // Keep the native loader in node_modules; esbuild cannot bundle it.
    external: ["@libsql/client", "libsql"],
    extensions: [
      additionalPackages({
        // Pin matches libsql@0.5.29 (package-lock). Unpinned would resolve
        // to "latest" on machines that skip the linux optional binary.
        packages: ["@libsql/linux-x64-gnu@0.5.29"],
      }),
    ],
  },
});
