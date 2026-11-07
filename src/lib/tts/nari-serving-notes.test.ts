/**
 * The Nari review is a pinned note, not a model swap. This fails if the
 * commits drift or the S2 image starts importing that package.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(rel: string): string {
  return readFileSync(path.join(root, rel), "utf8");
}

describe("nari serving notes", () => {
  it("pins the reviewed commits and keeps the Qwen server out of S2", () => {
    const notes = read("docs/nari-qwen3-serving.md");
    expect(notes).toContain("e8c5b2bf6d65a965037f161d713bfa3e8856feb3");
    expect(notes).toContain("a2d65e16fa121d9dbd80dfbb0cf1007563f96509");
    expect(notes).toContain("0c0e3051f131929182e2c023b9537f8b1c68adfe");
    expect(notes).toContain("Apache-2.0");
    expect(notes).toContain("No Nari source is copied");
    expect(notes).toContain("34.114 ms");
    for (const rel of ["modal/s2_contract.py", "modal/s2_batch.py", "modal/s2_clone_service.py"]) {
      expect(read(rel)).not.toContain("nari_qwen3");
      expect(read(rel)).not.toContain("Qwen3-TTS");
    }
  });
});
