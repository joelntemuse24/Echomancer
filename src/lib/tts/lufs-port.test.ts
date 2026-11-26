import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { integratedLufs } from "@/lib/tts/clone-sample-prepare";

const FIXTURE = path.join(process.cwd(), "scripts/sowell/fixtures/lufs-short.f32le");
const RATE = 16_000;

describe("short-section LUFS port", () => {
  it("matches integratedLufs on the shared fixture", () => {
    const bytes = readFileSync(FIXTURE);
    const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const ts = integratedLufs(samples, RATE);
    expect(ts).not.toBeNull();
    const py = spawnSync(
      "python3",
      [
        "-c",
        [
          "import sys",
          "sys.path.insert(0, sys.argv[1])",
          "import numpy as np",
          "from master import integrated_lufs",
          "samples = np.fromfile(sys.argv[2], dtype='<f4')",
          "print(integrated_lufs(samples, 16000))",
        ].join("\n"),
        path.join(process.cwd(), "scripts/sowell"),
        FIXTURE,
      ],
      { encoding: "utf8" }
    );
    expect(py.status, py.stderr).toBe(0);
    const python = Number(py.stdout.trim());
    expect(Number.isFinite(python)).toBe(true);
    expect(Math.abs(python - ts!)).toBeLessThan(0.05);
  });
});
