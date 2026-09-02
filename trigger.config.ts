import {
  additionalPackages,
  ffmpeg,
} from "@trigger.dev/build/extensions/core";
import type { BuildExtension } from "@trigger.dev/build";
import { defineConfig } from "@trigger.dev/sdk";

/**
 * Official DeepFilterNet rust CLI (tract/ONNX). musl static build is the
 * only linux-x64 artifact on v0.5.6 (~36MB). Copied into the Trigger
 * image at deploy — never onto Vercel. Not a Python wheel.
 */
const DEEP_FILTER_URL =
  "https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-x86_64-unknown-linux-musl";

function deepFilterBin(): BuildExtension {
  return {
    name: "deep-filter-bin",
    onBuildComplete(context) {
      if (context.target === "dev") return;
      context.logger.debug("Adding DeepFilterNet rust deep-filter binary", {
        url: DEEP_FILTER_URL,
      });
      context.addLayer({
        id: "deep-filter",
        image: {
          instructions: [
            [
              "RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates",
              `&& wget -q -O /usr/local/bin/deep-filter ${DEEP_FILTER_URL}`,
              "&& chmod +x /usr/local/bin/deep-filter",
              "&& apt-get clean && rm -rf /var/lib/apt/lists/*",
            ].join(" "),
          ],
        },
        deploy: {
          env: {
            DEEP_FILTER_BIN: "/usr/local/bin/deep-filter",
          },
          override: true,
        },
      });
    },
  };
}

/**
 * Trigger.dev Cloud runs Whole-book generation off Vercel.
 * Set TRIGGER_PROJECT_ID to the project ref from the Trigger dashboard
 * (proj_…). TRIGGER_SECRET_KEY must match on Vercel and in Trigger.
 *
 * Indexing imports takehome.ts → @libsql/client → libsql, which does
 * require(`@libsql/${currentTarget()}`). On Cloud (Linux x64 glibc) that
 * is @libsql/linux-x64-gnu — an optionalDependency, not a static import —
 * so additionalPackages must install it into the worker image.
 *
 * Full-book mastering (DFN3 70/30 + loudnorm) needs debian ffmpeg plus the
 * rust `deep-filter` binary. Both stay on this image — not the Vercel bundle.
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
        packages: [
          "@libsql/linux-x64-gnu@0.5.29",
          // Dynamic imports in text-extraction.ts; needed for upload.extract.
          "unpdf@1.4.0",
          "mammoth@1.12.0",
          "epub2@3.0.2",
        ],
      }),
      // Debian ffmpeg (amix + loudnorm). Not the 7.x static build.
      ffmpeg(),
      deepFilterBin(),
    ],
  },
});
