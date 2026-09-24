/**
 * Per-job scratch on local disk. Finalize streams audio through these
 * directories and deletes them when the upload finishes or fails.
 * Nothing here is a library artifact.
 */
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const SCRATCH_MAX_AGE_HOURS_DEFAULT = 24;
export const SCRATCH_SWEEP_MS_DEFAULT = 15 * 60 * 1000;

export function jobScratchRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.ECHOMANCER_SCRATCH_DIR?.trim();
  if (raw) return raw;
  return path.join(tmpdir(), "echomancer");
}

export function scratchMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const hours = Number(env.ECHOMANCER_SCRATCH_MAX_AGE_HOURS);
  const safe = Number.isFinite(hours) && hours > 0 ? hours : SCRATCH_MAX_AGE_HOURS_DEFAULT;
  return safe * 60 * 60 * 1000;
}

export function scratchSweepIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const ms = Number(env.ECHOMANCER_SCRATCH_SWEEP_MS);
  if (Number.isFinite(ms) && ms >= 60_000) return ms;
  return SCRATCH_SWEEP_MS_DEFAULT;
}

/** One directory per job id. The id is used as a single path segment. */
export function jobScratchDir(
  jobId: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const safe = jobId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  if (!safe) throw new Error("job scratch id is empty");
  return path.join(jobScratchRoot(env), safe);
}

export async function ensureJobScratchRoot(
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const root = jobScratchRoot(env);
  await mkdir(root, { recursive: true });
  return root;
}

export async function createJobScratch(
  jobId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const dir = jobScratchDir(jobId, env);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function removeJobScratch(
  jobId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  await rm(jobScratchDir(jobId, env), { recursive: true, force: true });
}

/**
 * Delete scratch children whose mtime is older than the max age.
 * In-flight finalize dirs stay (they are touched while the job runs).
 */
export async function sweepStaleJobScratch(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now()
): Promise<number> {
  const root = jobScratchRoot(env);
  const maxAge = scratchMaxAgeMs(env);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const full = path.join(root, name);
    try {
      const info = await stat(full);
      if (now - info.mtimeMs < maxAge) continue;
      await rm(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* raced with another sweep */
    }
  }
  if (removed > 0) {
    console.log(`[scratch] swept ${removed} stale dir(s) under ${root}`);
  }
  return removed;
}
