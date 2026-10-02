/**
 * One DeepFilterNet3 pass over a clone reference (worker only).
 *
 * Measured Oct 2026: on strong echo it lifted the clone's DNSMOS OVRL from
 * 1.7 to 2.8-3.2 with likeness unchanged. On noise, music and phone-band
 * clips it cut likeness by 0.05-0.10, so the gate only calls it for echo.
 * The `deep-filter` binary (DeepFilterNet 0.5.6, MIT/Apache-2.0) is CPU
 * only: about 7 s for a 32 s clip on the Contabo worker, 60 MB of memory.
 */

import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pcmToWav16 } from "@/lib/tts/section-squeak-guard";

const DFN_RATE = 48_000;
const DFN_TIMEOUT_MS = 90_000;

export function deepFilterPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEEP_FILTER_BIN?.trim() || "/usr/local/bin/deep-filter";
}

export async function deepFilterAvailable(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    await access(deepFilterPath(env), constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function run(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`deep-filter exit ${code}: ${stderr.slice(-300)}`));
    });
  });
}

/** 48 kHz mono PCM in → cleaned 48 kHz 16-bit WAV out. */
export async function deepFilterPcm(pcm48k: Float32Array): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "echomancer-dfn-"));
  try {
    const input = path.join(dir, "reference.wav");
    await writeFile(input, pcmToWav16(pcm48k, DFN_RATE));
    const outDir = path.join(dir, "out");
    await run(deepFilterPath(), ["--output-dir", outDir, input], DFN_TIMEOUT_MS);
    return await readFile(path.join(outDir, "reference.wav"));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export { DFN_RATE };
