import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createJobScratch,
  jobScratchDir,
  removeJobScratch,
  sweepStaleJobScratch,
} from "./job-scratch";

const ENV = {
  ECHOMANCER_SCRATCH_DIR: path.join("/tmp", `ec-scratch-test-${process.pid}`),
  ECHOMANCER_SCRATCH_MAX_AGE_HOURS: "1",
} as NodeJS.ProcessEnv;

afterEach(async () => {
  await removeJobScratch("job-a", ENV).catch(() => {});
  await sweepStaleJobScratch({ ...ENV, ECHOMANCER_SCRATCH_MAX_AGE_HOURS: "0.0001" });
});

describe("job scratch", () => {
  it("creates one dir per job and removes it", async () => {
    const dir = await createJobScratch("job-a", ENV);
    expect(dir).toBe(jobScratchDir("job-a", ENV));
    await writeFile(path.join(dir, "note.txt"), "x");
    await removeJobScratch("job-a", ENV);
    await expect(stat(dir)).rejects.toThrow();
  });

  it("sweeps only dirs older than the max age", async () => {
    const fresh = await createJobScratch("job-fresh", ENV);
    const staleRoot = jobScratchDir("job-stale", ENV);
    await mkdir(staleRoot, { recursive: true });
    await writeFile(path.join(staleRoot, "old.txt"), "x");
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(staleRoot, old, old);
    const removed = await sweepStaleJobScratch(ENV, Date.now());
    expect(removed).toBeGreaterThanOrEqual(1);
    await expect(stat(staleRoot)).rejects.toThrow();
    await expect(stat(fresh)).resolves.toBeTruthy();
    await removeJobScratch("job-fresh", ENV);
  });
});
