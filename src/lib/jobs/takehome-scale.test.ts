/**
 * Queue hardening for a later second worker. Concurrency stays 1.
 * Two libsql connections share a file database for the slot race.
 * No provider calls, no customer audio.
 */

import { createClient, type Client } from "@libsql/client";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  USER_A,
  USER_B,
  createFakeProvider,
  fakeMp3,
  jobRow,
  resetDatabase,
  seedJob,
  seedUpload,
} from "@/test/harness";
import { execute, query, queryOne } from "@/lib/turso";
import {
  ensureTtsJobColumns,
  resetSchemaMigrationCache,
} from "@/lib/tts/schema-migrate";
import {
  abortTakehomeCreate,
  beginTakehomeCreate,
  commitTakehomeCreate,
  resetTakehomeIdentityCache,
  takehomeIdemKey,
} from "@/lib/jobs/takehome-identity";
import {
  releaseProviderSlot,
  tryAcquireProviderSlot,
  type SlotSql,
} from "@/lib/tts/provider-slots";
import { cloneNarrationRecipeId } from "@/lib/tts/clone-narration-recipe";
import { sectionCacheKey } from "@/lib/tts/section-cache";
import { takehomeCacheVariant } from "@/lib/tts/process-job";

const PATH = "pdfs/scale-book/content.txt";

function clients(): { a: SlotSql; b: SlotSql; close: () => Promise<void> } {
  const dir = mkdtempSync(path.join(tmpdir(), "echo-scale-"));
  const url = `file:${path.join(dir, "slots.db")}`;
  const rawA = createClient({ url });
  const rawB = createClient({ url });
  const wrap = (client: Client): SlotSql => ({
    execute: async (sql, args) => {
      const result = await client.execute({ sql, args: args ?? [] });
      return { rowsAffected: result.rowsAffected };
    },
    queryOne: async <T>(sql: string, args?: (string | number | null)[]) => {
      const result = await client.execute({ sql, args: args ?? [] });
      return (result.rows[0] as T) ?? null;
    },
  });
  return {
    a: wrap(rawA),
    b: wrap(rawB),
    close: async () => {
      rawA.close();
      rawB.close();
    },
  };
}

beforeEach(async () => {
  await resetDatabase();
});

describe("take-home create identity", () => {
  it("lets only one of two overlapping creates reserve the key", async () => {
    const input = {
      userId: USER_A,
      pdfStoragePath: PATH,
      ttsProvider: "edge",
      catalogVoiceId: "ryan",
      providerVoiceId: "en-GB-RyanNeural",
    };
    const [first, second] = await Promise.allSettled([
      beginTakehomeCreate({ ...input, jobId: "job-a" }),
      beginTakehomeCreate({ ...input, jobId: "job-b" }),
    ]);
    const won = [first, second].filter(
      (result) => result.status === "fulfilled" && result.value.action === "insert"
    );
    expect(won).toHaveLength(1);
    const reserved =
      first.status === "fulfilled" && first.value.action === "insert"
        ? first.value
        : second.status === "fulfilled" && second.value.action === "insert"
          ? second.value
          : null;
    expect(reserved?.action).toBe("insert");
    if (!reserved || reserved.action !== "insert") return;
    await commitTakehomeCreate(reserved.idemKey, reserved.jobId);
    await execute(
      `INSERT INTO jobs (
         id, user_id, book_title, pdf_storage_path, status, job_kind,
         tts_provider, catalog_voice_id, provider_voice_id
       ) VALUES (?, ?, 'Book', ?, 'queued', 'takehome', 'edge', 'ryan', 'en-GB-RyanNeural')`,
      [reserved.jobId, USER_A, PATH]
    );
    const again = await beginTakehomeCreate({ ...input, jobId: "job-c" });
    expect(again).toMatchObject({ action: "use", jobId: reserved.jobId });
    const keys = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM takehome_create_keys`
    );
    expect(Number(keys[0]?.n)).toBe(1);
  });

  it("keeps historical duplicates and returns the oldest live job", async () => {
    const older = "job-older";
    const newer = "job-newer";
    for (const [id, created] of [
      [older, 10],
      [newer, 20],
    ] as const) {
      await execute(
        `INSERT INTO jobs (
           id, user_id, book_title, pdf_storage_path, status, job_kind,
           tts_provider, catalog_voice_id, provider_voice_id, created_at
         ) VALUES (?, ?, 'Book', ?, 'queued', 'takehome', 'edge', 'ryan', 'en-GB-RyanNeural', ?)`,
        [id, USER_A, PATH, created]
      );
    }
    const opened = await beginTakehomeCreate({
      userId: USER_A,
      pdfStoragePath: PATH,
      ttsProvider: "edge",
      catalogVoiceId: "ryan",
      providerVoiceId: "en-GB-RyanNeural",
      jobId: "job-new",
    });
    expect(opened).toMatchObject({ action: "use", jobId: older });
    const rows = await query<{ id: string }>(`SELECT id FROM jobs ORDER BY id`);
    expect(rows.map((row) => row.id).sort()).toEqual([newer, older].sort());
  });

  it("allows another book after the previous one failed", async () => {
    await execute(
      `INSERT INTO jobs (
         id, user_id, book_title, pdf_storage_path, status, job_kind,
         tts_provider, catalog_voice_id, provider_voice_id
       ) VALUES ('job-failed', ?, 'Book', ?, 'failed', 'takehome', 'edge', 'ryan', 'en-GB-RyanNeural')`,
      [USER_A, PATH]
    );
    const opened = await beginTakehomeCreate({
      userId: USER_A,
      pdfStoragePath: PATH,
      ttsProvider: "edge",
      catalogVoiceId: "ryan",
      providerVoiceId: "en-GB-RyanNeural",
      jobId: "job-retry",
    });
    expect(opened.action).toBe("insert");
    expect(takehomeIdemKey({
      userId: USER_A,
      pdfStoragePath: PATH,
      ttsProvider: "edge",
      catalogVoiceId: "ryan",
      providerVoiceId: "en-GB-RyanNeural",
    })).toContain(USER_A);
    const still = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs`);
    expect(Number(still[0]?.n)).toBe(1);
  });

  it("recovers a reservation that never committed", async () => {
    const input = {
      userId: USER_A,
      pdfStoragePath: PATH,
      ttsProvider: "edge",
      catalogVoiceId: "ryan",
      providerVoiceId: "en-GB-RyanNeural",
    };
    const crashed = await beginTakehomeCreate({ ...input, jobId: "job-crash" });
    expect(crashed.action).toBe("insert");
    if (crashed.action !== "insert") return;
    await abortTakehomeCreate(crashed.idemKey, crashed.jobId);
    const retried = await beginTakehomeCreate({ ...input, jobId: "job-retry" });
    expect(retried).toMatchObject({ action: "insert", jobId: "job-retry" });

    const stuck = await beginTakehomeCreate({
      ...input,
      pdfStoragePath: PATH + "-stuck",
      jobId: "job-stuck",
    });
    expect(stuck.action).toBe("insert");
    await execute(
      `UPDATE takehome_create_keys SET reserved_until = unixepoch() - 1
       WHERE job_id = 'job-stuck' AND committed = 0`
    );
    const stolen = await beginTakehomeCreate({
      ...input,
      pdfStoragePath: PATH + "-stuck",
      jobId: "job-recover",
    });
    expect(stolen).toMatchObject({ action: "insert", jobId: "job-recover" });
  });

  it("backfills the oldest live row and can run twice without deleting jobs", async () => {
    for (const [id, created] of [
      ["job-dup-a", 5],
      ["job-dup-b", 15],
    ] as const) {
      await execute(
        `INSERT INTO jobs (
           id, user_id, book_title, pdf_storage_path, status, job_kind,
           tts_provider, catalog_voice_id, provider_voice_id, created_at
         ) VALUES (?, ?, 'Book', ?, 'queued', 'takehome', 'edge', 'ryan', 'en-GB-RyanNeural', ?)`,
        [id, USER_A, PATH, created]
      );
    }
    await execute(`DROP TABLE takehome_create_keys`);
    resetTakehomeIdentityCache();
    resetSchemaMigrationCache();
    expect(await ensureTtsJobColumns()).toBe("migrated");
    expect(await ensureTtsJobColumns()).toBe("hot");
    const jobs = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs`);
    const keys = await queryOne<{ n: number; job_id: string }>(
      `SELECT COUNT(*) AS n, MIN(job_id) AS job_id FROM takehome_create_keys`
    );
    expect(Number(jobs[0]?.n)).toBe(2);
    expect(Number(keys?.n)).toBe(1);
    expect(keys?.job_id).toBe("job-dup-a");
  });
});

describe("provider slots across connections", () => {
  let pair: ReturnType<typeof clients>;

  afterEach(async () => {
    await pair?.close();
  });

  it("shares a cap, ignores a stale release, and steals only after expiry", async () => {
    pair = clients();
    const first = await tryAcquireProviderSlot(pair.a, {
      provider: "fish",
      cap: 1,
      ownerToken: "owner-a",
      jobId: "job-a",
      ttlSeconds: 90,
    });
    const blocked = await tryAcquireProviderSlot(pair.b, {
      provider: "fish",
      cap: 1,
      ownerToken: "owner-b",
      jobId: "job-b",
      ttlSeconds: 90,
    });
    expect(first).toBe(0);
    expect(blocked).toBeNull();
    const stale = await releaseProviderSlot(pair.b, {
      provider: "fish",
      slotId: 0,
      ownerToken: "owner-b",
    });
    expect(stale).toBe(false);
    const stillBlocked = await tryAcquireProviderSlot(pair.b, {
      provider: "fish",
      cap: 1,
      ownerToken: "owner-b",
      jobId: "job-b",
      ttlSeconds: 90,
    });
    expect(stillBlocked).toBeNull();
    await pair.a.execute(
      `UPDATE provider_slots SET expires_at = unixepoch() - 1
       WHERE provider = 'fish' AND slot_id = 0 AND owner_token = 'owner-a'`
    );
    const stolen = await tryAcquireProviderSlot(pair.b, {
      provider: "fish",
      cap: 1,
      ownerToken: "owner-b",
      jobId: "job-b",
      ttlSeconds: 90,
    });
    expect(stolen).toBe(0);
    const owner = await pair.a.queryOne<{ owner_token: string }>(
      `SELECT owner_token FROM provider_slots WHERE provider = 'fish' AND slot_id = 0`
    );
    expect(owner?.owner_token).toBe("owner-b");
  });

  it("lets only one of two connections take the last slot", async () => {
    pair = clients();
    const [left, right] = await Promise.all([
      tryAcquireProviderSlot(pair.a, {
        provider: "edge",
        cap: 1,
        ownerToken: "owner-a",
        jobId: "job-a",
        ttlSeconds: 90,
      }),
      tryAcquireProviderSlot(pair.b, {
        provider: "edge",
        cap: 1,
        ownerToken: "owner-b",
        jobId: "job-b",
        ttlSeconds: 90,
      }),
    ]);
    const won = [left, right].filter((slot) => slot === 0);
    expect(won).toHaveLength(1);
    expect([left, right].filter((slot) => slot === null)).toHaveLength(1);
  });
});

describe("queue fairness", () => {
  it("serves the other user before the same user's untouched backlog", async () => {
    const pathA = await seedUpload({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      userId: USER_A,
      text: "One.",
    });
    const pathB = await seedUpload({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      userId: USER_B,
      text: "Two.",
    });
    await seedJob({
      id: "job-a1",
      userId: USER_A,
      pdfStoragePath: pathA,
      ttsProvider: "edge",
      catalogVoiceId: "ryan",
      providerVoiceId: "en-GB-RyanNeural",
    });
    await seedJob({
      id: "job-a2",
      userId: USER_A,
      pdfStoragePath: pathA + "-2",
      ttsProvider: "edge",
      catalogVoiceId: "ryan",
      providerVoiceId: "en-GB-RyanNeural",
    });
    await execute(
      `INSERT INTO uploads (id, user_id, storage_path, file_name, format, status)
       VALUES ('up-a2', ?, ?, 'a2.txt', 'txt', 'ready')`,
      [USER_A, pathA + "-2"]
    );
    await seedJob({
      id: "job-b1",
      userId: USER_B,
      pdfStoragePath: pathB,
      ttsProvider: "edge",
      catalogVoiceId: "ryan",
      providerVoiceId: "en-GB-RyanNeural",
    });
    await execute(
      `UPDATE jobs SET updated_at = 1 WHERE id = 'job-a2'`
    );
    await execute(
      `UPDATE jobs SET updated_at = 2 WHERE id = 'job-a1'`
    );
    await execute(
      `UPDATE jobs SET updated_at = 50 WHERE id = 'job-b1'`
    );
    const { claimTakehomeLease, listDrainableTakehomeJobs } = await import(
      "@/lib/tts/process-job"
    );
    expect(await claimTakehomeLease("job-a1")).toBeTruthy();
    await execute(
      `UPDATE jobs SET status = 'queued', processing_lease_token = NULL,
         lease_expires_at = NULL, updated_at = 100 WHERE id = 'job-a1'`
    );
    const order = await listDrainableTakehomeJobs();
    expect(order[0]).toBe("job-b1");
    expect(order).toContain("job-a2");
  });

  it("skips a user who already holds the in-flight cap", async () => {
    const pathA = await seedUpload({
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
      userId: USER_A,
      text: "Held.",
    });
    const pathB = await seedUpload({
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
      userId: USER_B,
      text: "Waiting.",
    });
    await seedJob({
      id: "job-held",
      userId: USER_A,
      pdfStoragePath: pathA,
      status: "processing",
    });
    await execute(
      `UPDATE jobs SET lease_expires_at = unixepoch() + 90,
         processing_lease_token = 'held' WHERE id = 'job-held'`
    );
    await seedJob({
      id: "job-a-backlog",
      userId: USER_A,
      pdfStoragePath: pathA + "-backlog",
    });
    await seedJob({
      id: "job-b-next",
      userId: USER_B,
      pdfStoragePath: pathB,
    });
    const { listDrainableTakehomeJobs } = await import("@/lib/tts/process-job");
    const capped = await listDrainableTakehomeJobs();
    expect(capped).toContain("job-b-next");
    expect(capped).not.toContain("job-a-backlog");
    process.env.TAKEHOME_MAX_INFLIGHT_PER_USER = "0";
    try {
      const open = await listDrainableTakehomeJobs();
      expect(open).toContain("job-a-backlog");
      expect(open).toContain("job-b-next");
    } finally {
      delete process.env.TAKEHOME_MAX_INFLIGHT_PER_USER;
    }
  });
});

describe("shared edge cap", () => {
  it("returns the book to the queue without synthesizing when the cap is full", async () => {
    const pdfPath = await seedUpload({
      id: "ffffffff-ffff-4fff-8fff-fffffffffff1",
      userId: USER_A,
      text: "Chapter 1.\n\nThe harbor was quiet after the rain.",
    });
    await seedJob({
      id: "job-edge-cap",
      userId: USER_A,
      pdfStoragePath: pdfPath,
      ttsProvider: "edge",
      catalogVoiceId: "standard",
      providerVoiceId: "en-US-AndrewNeural",
    });
    const held = await tryAcquireProviderSlot(
      {
        execute: (sql, args) => execute(sql, args),
        queryOne: async () => null,
      },
      {
        provider: "edge",
        cap: 1,
        ownerToken: "other-worker",
        jobId: "other-job",
        ttlSeconds: 90,
      }
    );
    expect(held).toBe(0);
    const providers = await import("@/lib/tts/providers");
    const fake = createFakeProvider(async () => {
      throw new Error("should not synthesize");
    });
    fake.id = "edge";
    vi.spyOn(providers, "resolveStockAdapter").mockReturnValue(fake);
    process.env.TTS_EDGE_GOOGLE_SECTION_CONCURRENCY = "1";
    process.env.TTS_SECTION_QA_ENABLED = "0";
    try {
      const { processTakehomeTick } = await import("@/lib/tts/process-job");
      const result = await processTakehomeTick("job-edge-cap", {
        sectionsPerTick: 2,
        deadlineMs: Date.now() + 120_000,
      });
      expect(result.deferred).toBe(true);
      expect(fake.calls.length).toBe(0);
      const row = await jobRow("job-edge-cap");
      expect(row?.status).toBe("queued");
      expect(row?.status).not.toBe("failed");
    } finally {
      delete process.env.TTS_EDGE_GOOGLE_SECTION_CONCURRENCY;
      delete process.env.TTS_SECTION_QA_ENABLED;
      vi.restoreAllMocks();
    }
  });
});

describe("cancellation between sections", () => {
  it("does not start another section after cancel, and does not mark the book ready", async () => {
    const pdfPath = await seedUpload({
      id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
      userId: USER_A,
      text: Array.from(
        { length: 6 },
        (_, i) =>
          `Chapter ${i + 1}.\n\n${"The harbor was quiet after the rain. ".repeat(40)}`
      ).join("\n\n"),
    });
    await seedJob({
      id: "job-cancel",
      userId: USER_A,
      pdfStoragePath: pdfPath,
      ttsProvider: "edge",
      catalogVoiceId: "standard",
      providerVoiceId: "en-US-AndrewNeural",
    });
    const providers = await import("@/lib/tts/providers");
    const turso = await import("@/lib/turso");
    const fake = createFakeProvider(async () => {
      return { audio: fakeMp3(), contentType: "audio/mpeg" };
    });
    fake.id = "edge";
    vi.spyOn(providers, "resolveStockAdapter").mockReturnValue(fake);
    // The first section is allowed to finish. Cancel is the same write the
    // cancel route does: status and lease token. The next claim must stop.
    // The in-flight provider call is not aborted.
    const realExecute = turso.execute;
    vi.spyOn(turso, "execute").mockImplementation(async (sql, args) => {
      const result = await realExecute(sql, args);
      if (
        typeof sql === "string" &&
        sql.includes("segments_json") &&
        sql.includes("status = 'processing'")
      ) {
        await realExecute(
          `UPDATE jobs SET status = 'cancelled', processing_lease_token = NULL,
             lease_expires_at = NULL WHERE id = 'job-cancel'`
        );
      }
      return result;
    });
    process.env.TTS_EDGE_GOOGLE_SECTION_CONCURRENCY = "1";
    process.env.TTS_SECTION_QA_ENABLED = "0";
    try {
      const { processTakehomeTick } = await import("@/lib/tts/process-job");
      await processTakehomeTick("job-cancel", {
        sectionsPerTick: 4,
        deadlineMs: Date.now() + 120_000,
      }).catch(() => undefined);
      expect(fake.calls.length).toBe(1);
      const row = await jobRow("job-cancel");
      expect(row?.status).toBe("cancelled");
      expect(row?.status).not.toBe("ready");
    } finally {
      delete process.env.TTS_EDGE_GOOGLE_SECTION_CONCURRENCY;
      delete process.env.TTS_SECTION_QA_ENABLED;
      vi.restoreAllMocks();
    }
  });
});

describe("section cache identity", () => {
  it("keeps the recipe in the variant and ignores the job id", () => {
    const previousUrl = process.env.MODAL_S2_TTS_URL;
    const previousProvider = process.env.CLONE_TTS_PROVIDER;
    process.env.MODAL_S2_TTS_URL = "https://example.invalid";
    delete process.env.CLONE_TTS_PROVIDER;
    try {
      const variant = takehomeCacheVariant("fish", "clone:example");
      expect(variant).toBe(`s2-pro-modal-${cloneNarrationRecipeId()}`);
      expect(variant).not.toBe("s2-pro-modal-v1");
      expect(variant).not.toContain("drama");
      const key = sectionCacheKey({
        text: "The harbor was quiet.",
        voiceId: "ref",
        model: "s2",
        latency: "normal",
        speed: 1,
        chunkLength: 300,
        variant,
      });
      expect(key).toBe(
        sectionCacheKey({
          text: "The harbor was quiet.",
          voiceId: "ref",
          model: "s2",
          latency: "normal",
          speed: 1,
          chunkLength: 300,
          variant,
        })
      );
      expect(key).not.toContain("job-");
    } finally {
      if (previousUrl === undefined) delete process.env.MODAL_S2_TTS_URL;
      else process.env.MODAL_S2_TTS_URL = previousUrl;
      if (previousProvider === undefined) delete process.env.CLONE_TTS_PROVIDER;
      else process.env.CLONE_TTS_PROVIDER = previousProvider;
    }
  });
});
