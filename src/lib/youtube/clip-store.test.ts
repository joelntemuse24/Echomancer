import { AppError } from "@/lib/errors";
import { uploadFile } from "@/lib/storage";
import { insertClonedVoice } from "@/lib/turso/cloned-voices";
import { stat } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { execute } from "@/lib/turso";
import { resetDatabase } from "@/test/harness";
import { masterClipPcm } from "./clip-master";
import { runClaimedClip } from "./clip-job";
import {
  claimYoutubeClip,
  acceptYoutubeClipRisk,
  checkpointYoutubeClip,
  heartbeatYoutubeClip,
  recoverYoutubeClips,
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
        return {
          ok: false,
          code: "timeout",
          bytes: 128,
          runId: "run-1",
          usd: 0.02,
          actor: "link",
          actorsTried: 2,
        };
      },
    });
    const saved = await getYoutubeClipForUser(USER, "job");
    expect(saved?.status).toBe("failed");
    expect(saved?.error_code).toBe("timeout");
    expect(Number(saved?.bytes_proxy)).toBe(128);
    expect(saved?.apify_run_id).toBe("run-1");
    expect(Number(saved?.apify_usd)).toBeCloseTo(0.02);
    await expect(stat(cwd)).rejects.toThrow();
    if (process.platform !== "win32") expect(mode).toBe(0o700);
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
    await setYoutubeClipPhase("retry", "preparing", row!.lease_token!);
    await runClaimedClip(row!, {
      token: "test-token",
      download: async () => ({
        ok: false,
        code: "transient",
        bytes: 0,
        runId: "run-r",
        usd: 0,
        actor: "link",
        actorsTried: 1,
      }),
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
      download: async () => ({
        ok: false,
        code: "transient",
        bytes: 0,
        runId: "run-t",
        usd: 0,
        actor: "link",
        actorsTried: 1,
      }),
    });
    const saved = await getYoutubeClipForUser(USER, "blip");
    expect(saved?.status).toBe("queued");
    expect(saved?.error_code).toBeNull();
    expect(Number(saved?.apify_usd)).toBe(0);
  });

  it("does not requeue a missing video", async () => {
    await resetDatabase();
    await queue("again");
    const row = await claimYoutubeClip();
    await runClaimedClip(row!, {
      token: "test-token",
      download: async () => ({
        ok: false,
        code: "unavailable",
        bytes: 0,
        runId: "run-u",
        usd: 0,
        actor: "link",
        actorsTried: 1,
      }),
    });
    const saved = await getYoutubeClipForUser(USER, "again");
    expect(saved?.status).toBe("failed");
    expect(saved?.error_code).toBe("unavailable");
  });

  it("marks a range failure terminal", async () => {
    await resetDatabase();
    await queue("bad");
    const row = await claimYoutubeClip();
    await runClaimedClip(row!, {
      token: "test-token",
      download: async () => ({
        ok: false,
        code: "range_unsupported",
        bytes: 0,
        runId: null,
        usd: 0,
        actor: "link",
        actorsTried: 2,
      }),
    });
    const saved = await getYoutubeClipForUser(USER, "bad");
    expect(saved?.status).toBe("failed");
    expect(saved?.error_code).toBe("range_unsupported");
  });

  it("masters a decoded section and records the object key", async () => {
    await resetDatabase();
    await queue("ok");
    const row = await claimYoutubeClip();
    const n = 48_000 * 20;
    const pcm = new Float32Array(n);
    for (let i = 0; i < n; i++) pcm[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / 48_000);
    let cloned = 0;
    await runClaimedClip(row!, {
      token: "test-token",
      download: async () => ({ ok: true, file: "audio.m4a", bytes: 2000, runId: "run-ok", usd: 0.03, actor: "link" }),
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

  it("reclaims expired leases and rejects stale phase, heartbeat, and completion writes", async () => {
    await resetDatabase();
    await queue("race");
    const first = (await claimYoutubeClip())!;
    expect(await claimYoutubeClip()).toBeNull();
    await execute(`UPDATE youtube_clips SET lease_expires_at = 0 WHERE id = 'race'`);
    const second = (await claimYoutubeClip())!;
    expect(second.lease_token).not.toBe(first.lease_token);
    expect(second.attempts).toBe(2);
    expect(await heartbeatYoutubeClip(first.id, first.lease_token!)).toBe(false);
    await expect(setYoutubeClipPhase(first.id, "preparing", first.lease_token!)).rejects.toThrow("lease lost");
    await finishYoutubeClip({ id: first.id, leaseToken: first.lease_token!, status: "failed", bytesProxy: 900 });
    expect((await getYoutubeClipForUser(USER, first.id))?.status).toBe("running");
    expect((await getYoutubeClipForUser(USER, first.id))?.bytes_proxy).toBe(0);
    await execute(`UPDATE youtube_clips SET lease_expires_at = 0 WHERE id = 'race'`);
    expect(await claimYoutubeClip()).toBeNull();
    expect((await getYoutubeClipForUser(USER, first.id))?.status).toBe("failed");
  });

  it("recovers a stored WAV without downloading or decoding it again", async () => {
    await resetDatabase();
    await queue("resume");
    const first = (await claimYoutubeClip())!;
    const wav = Buffer.from("stored prepared sample");
    const stored = await uploadFile(`clips/${USER}`, "resume.wav", wav, "audio/wav");
    await checkpointYoutubeClip(first.id, first.lease_token!, { r2Key: stored.path });
    await execute(`UPDATE youtube_clips SET lease_expires_at = 0 WHERE id = 'resume'`);
    const second = (await claimYoutubeClip())!;
    let clones = 0;
    await runClaimedClip(second, {
      download: async () => { throw new Error("must reuse WAV"); },
      decode: async () => { throw new Error("must reuse WAV"); },
      clone: async (_row, sample) => { expect(sample).toEqual(wav); clones++; },
    });
    expect(clones).toBe(1);
    expect((await getYoutubeClipForUser(USER, "resume"))?.status).toBe("ready");
  });

  it("does not repeat an ambiguous provider create, but reconciles a committed clone", async () => {
    await resetDatabase();
    await queue("uncertain");
    const first = (await claimYoutubeClip())!;
    await checkpointYoutubeClip(first.id, first.lease_token!, { createStarted: true });
    await execute(`UPDATE youtube_clips SET lease_expires_at = 0 WHERE id = 'uncertain'`);
    await recoverYoutubeClips();
    expect((await getYoutubeClipForUser(USER, first.id))?.error_code).toBe("provider_uncertain");
    expect(await claimYoutubeClip()).toBeNull();
    await queue("committed");
    const committed = (await claimYoutubeClip())!;
    await checkpointYoutubeClip(committed.id, committed.lease_token!, { createStarted: true });
    await insertClonedVoice({ id: committed.id, userId: USER, fishVoiceId: "fish-existing", title: "Existing", state: "trained", model: "s2-pro" });
    await execute(`UPDATE youtube_clips SET lease_expires_at = 0 WHERE id = 'committed'`);
    await recoverYoutubeClips();
    const saved = await getYoutubeClipForUser(USER, committed.id);
    expect(saved?.status).toBe("ready");
    expect(saved?.error_code).toBeNull();
  });

  it("keeps quality rejection before the create marker and atomically accepts it once", async () => {
    await resetDatabase();
    await queue("risk-boundary");
    const stored = await uploadFile(`clips/${USER}`, "risk-boundary.wav", Buffer.from("prepared"), "audio/wav");
    const first = (await claimYoutubeClip())!;
    await checkpointYoutubeClip(first.id, first.lease_token!, { r2Key: stored.path });
    first.r2_key = stored.path;
    await runClaimedClip(first, { clone: async () => { throw new AppError("SAMPLE_RISKY", "Risk", 409, { quality: { verdict: "fail" } }); } });
    const rejected = await getYoutubeClipForUser(USER, first.id);
    expect(rejected?.create_started_at).toBeNull();
    expect(rejected?.error_code).toBe("risky_audio");
    const accepted = await Promise.all([acceptYoutubeClipRisk(USER, first.id), acceptYoutubeClipRisk(USER, first.id)]);
    expect(accepted.filter(Boolean)).toHaveLength(1);
    const second = (await claimYoutubeClip())!;
    expect(second.accept_quality_risk).toBe(1);
    expect(second.attempts).toBe(2);
    await runClaimedClip(second, { clone: async (_row, _wav, _signal, beforeCreate) => { await beforeCreate(); throw new Error("provider disconnected"); } });
    expect((await getYoutubeClipForUser(USER, first.id))?.error_code).toBe("provider_uncertain");
    expect(await acceptYoutubeClipRisk(USER, first.id)).toBeNull();
    expect(await claimYoutubeClip()).toBeNull();
  });

  it("stores bytes on a finished row", async () => {
    await resetDatabase();
    await queue("done");
    const claimed = await claimYoutubeClip();
    await finishYoutubeClip({
      id: "done",
      leaseToken: claimed!.lease_token!,
      status: "failed",
      errorCode: "budget",
      bytesProxy: 10,
    });
    const saved = await getYoutubeClipForUser(USER, "done");
    expect(saved?.error_code).toBe("budget");
    await execute(`DELETE FROM youtube_clips WHERE id = ?`, ["done"]);
  });
});
