import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkFiles(full));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

const FORBIDDEN =
  /\b(ffmpeg|fluent-ffmpeg|@ffmpeg|torch|deepfilternet|deep-filter|mastering-worker)\b/i;

describe("Vercel hot path stays free of ffmpeg/torch", () => {
  it("does not import ffmpeg, torch, or the mastering worker from src/app/api", () => {
    const apiRoot = path.join(root, "src/app/api");
    const offenders: string[] = [];
    for (const file of walkFiles(apiRoot)) {
      const text = readFileSync(file, "utf8");
      if (FORBIDDEN.test(text)) {
        offenders.push(path.relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not statically import the Trigger mastering worker from concat-audio", () => {
    const concat = readFileSync(
      path.join(root, "src/lib/tts/concat-audio.ts"),
      "utf8"
    );
    expect(concat).not.toMatch(
      /from\s+["']@\/lib\/tts\/mastering-worker["']/
    );
    expect(concat).not.toMatch(/\bffmpeg\b/);
    expect(concat).not.toMatch(/\btorch\b/);
  });
});
