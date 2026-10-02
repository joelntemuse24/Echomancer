import { stat } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { execute } from "@/lib/turso";
import { resetDatabase } from "@/test/harness";
import { masterClipPcm } from "./clip-master";
import { runClaimedClip } from "./clip-job";
import {
  claimYoutubeClip,
  finishYoutubeClip,
  getYoutubeClipForUser,
  insertYoutubeClip,
  setYoutubeClipPhase,
} from "./clip-store";

const USER = "user_clipstore";

async function queue(id: string) {
  await insertYoutubeClip({
    id,
    userId: USER,
    videoId: "abcdefghijk",
    startSeconds: 10,
    lengthSeconds: 20,
    consentAt: 1_700_000_000_000,
  });
}

describe("youtube clip queue", () => {
  afterEach(() => {
    delete process.env.APIFY_TOKEN;
  });

  it("claims one queued row at a time", async () => {
    await resetDatabase();
    await queue("one");
    await queue("two");
    const first = await claimYoutubeClip();
    const second = await claimYoutubeClip();
    const third = await claimYoutubeClip();
    expect(first?.id).toBe("one");
    expect(Number(first?.attempts)).toBe(1);
    expect(first?.status).toBe("running");
    expect(second?.id).toBe("two");
    expect(third).toBeNull();
  });

  it("records a timeout without starting another run, and removes the temp dir", async () => {
    await resetDatabase();
    await queue("job");
    const row = await claimYoutubeClip();
    expect(row).not.toBeNull();
    let mode = 0;
    let cwd = "";
    await runClaimedClip(row!, {
      token: "test-token",
      download: async (opts) => {
        cwd = opts.cwd;
        mode = (await stat(opts.cwd)).mode & 0o777;
        return { ok: false, code: "timeout", bytes: 128, runId: "run-1", usd: 0.02 };
      },
    });
    const saved = await getYoutubeClipForUser(USER, "job");
    expect(saved?.status).toBe("failed");
    expect(saved?.error_code).toBe("timeout");
    expect(Number(saved?.bytes_proxy)).toBe(128);
    expect(saved?.apify_run_id).toBe("run-1");
    expect(Number(saved?.apify_usd)).toBeCloseTo(0.02);
    await expect(stat(cwd)).rejects.toThrow();
    expect(mode).toBe(0o700);
  });

  it("fetches at most 40 seconds when a stored row is longer", async () => {
    await resetDatabase();
    await insertYoutubeClip({
      id: "long",
      userId: USER,
      videoId: "abcdefghijk",
      startSeconds: 12,
      lengthSeconds: 90,
      consentAt: 1,
    });
    const row = await claimYoutubeClip();
    let end = 0;
    await runClaimedClip(row!, {
      token: "test-token",
      download: async (opts) => {
        end = opts.endSec;
        return { ok: false, code: "timeout", bytes: 0, runId: null, usd: 0 };
      },
    });
    expect(end).toBe(52);
    const saved = await getYoutubeClipForUser(USER, "long");
    expect(Number(saved?.length_seconds)).toBe(90);
    expect(saved?.status).toBe("failed");
  });

  it("clears a stale preparing phase when the clip is queued again", async () => {
    await resetDatabase();
    await queue("retry");
    const row = await claimYoutubeClip();
    await setYoutubeClipPhase("retry", "preparing");
    await runClaimedClip(row!, {
      token: "test-token",
      download: async () => ({ ok: false, code: "transient", bytes: 0, runId: "run-r", usd: 0 }),
    });
    const saved = await getYoutubeClipForUser(USER, "retry");
    expect(saved?.status).toBe("queued");
    expect(saved?.phase ?? null).toBeNull();
  });

  it("requeues a transient download failure once", async () => {
    await resetDatabase();
    await queue("blip");
    const row = await claimYoutubeClip();
    await runClaimedClip(row!, {
      token: "test-token",
      download: async () => ({ ok: false, code: "transient", bytes: 0, runId: "run-t", usd: 0 }),
    });
    const saved = await getYoutubeClipForUser(USER, "blip");
    expect(saved?.status).toBe("queued");
    expect(saved?.error_code).toBeNull();
    expect(Number(saved?.apify_usd)).toBe(0);
  });

  it("requeues an unavailable result once", async () => {
    await resetDatabase();
    await queue("again");
    const row = await claimYoutubeClip();
    await runClaimedClip(row!, {
      token: "test-token",
      download: async () => ({ ok: false, code: "unavailable", bytes: 0, runId: "run-u", usd: 0 }),
    });
    const saved = await getYoutubeClipForUser(USER, "again");
    expect(saved?.status).toBe("queued");
    expect(saved?.error_code).toBeNull();
  });

  it("marks a range failure terminal", async () => {
    await resetDatabase();
    await queue("bad");
    const row = await claimYoutubeClip();
    await runClaimedClip(row!, {
      token: "test-token",
      download: async () => ({ ok: false, code: "range_unsupported", bytes: 0, runId: null, usd: 0 }),
    });
    const saved = await getYoutubeClipForUser(USER, "bad");
    expect(saved?.status).toBe("failed");
    expect(saved?.error_code).toBe("range_unsupported");
  });

  it("masters a decoded section and records the object key", async () => {
    await resetDatabase();
    await queue("ok");
    const row = await claimYoutubeClip();
    const n = 48_000 * 12;
    const pcm = new Float32Array(n);
    for (let i = 0; i < n; i++) pcm[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / 48_000);
    let cloned = 0;
    await runClaimedClip(row!, {
      token: "test-token",
      download: async () => ({ ok: true, file: "audio.m4a", bytes: 2000, runId: "run-ok", usd: 0.03 }),
      decode: async () => pcm,
      clone: async (_row, wav) => {
        expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
        cloned += 1;
      },
    });
    const saved = await getYoutubeClipForUser(USER, "ok");
    expect(saved?.status).toBe("ready");
    expect(saved?.r2_key).toBe(`clips/${USER}/ok.wav`);
    expect(cloned).toBe(1);
    expect(masterClipPcm(pcm).ok).toBe(true);
  });

  it("stores bytes on a finished row", async () => {
    await resetDatabase();
    await queue("done");
    await finishYoutubeClip({
      id: "done",
      status: "failed",
      errorCode: "budget",
      bytesProxy: 10,
    });
    const saved = await getYoutubeClipForUser(USER, "done");
    expect(saved?.error_code).toBe("budget");
    await execute(`DELETE FROM youtube_clips WHERE id = ?`, ["done"]);
  });
});
