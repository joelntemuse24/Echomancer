/**
 * CPU dispatch is single-flight. The orchestrator does not wait out the
 * container, a timed-out caller does not start a second one, and a late
 * completion is kept. No paid provider and no Modal API.
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
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
import { execute, query } from "@/lib/turso";
import { fileExists } from "@/lib/storage";
import {
  cpuConcatBudgetSeconds,
  cpuDispatchAcceptMs,
  cpuSectionBudgetSeconds,
} from "@/lib/cpu/deadlines";
import { commitSectionAudio, promoteFinishedSections } from "@/lib/cpu/section-publish";
import {
  completeCpuTask,
  enqueueCpuTask,
  getCpuTask,
  requeueExpiredCpuTasks,
} from "@/lib/cpu/tasks";
import { runCpuTask } from "@/lib/cpu/runner";
import { resetModalWorkspaceDisabled } from "@/lib/modal/workspace-disabled";
import { readFileSync } from "node:fs";
import path from "node:path";
import { effectiveOrchestratorConcurrency } from "@/worker/concurrency";

const USER_C = "anon_" + "c".repeat(32);
const USER_D = "anon_" + "d".repeat(32);

function toneWav(): Buffer {
  const sampleRate = 16_000;
  const samples = Math.floor(sampleRate * 0.4);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.2;
    data.writeInt16LE(Math.max(-32767, Math.min(32767, value * 32767)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function listen(
  handler: (body: { taskId?: string; ownerToken?: string }) => Promise<{
    status: number;
    json: unknown;
  }>
): Promise<{ server: Server; url: string; posts: () => number }> {
  let posts = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      posts += 1;
      void (async () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const body = raw
          ? (JSON.parse(raw) as { taskId?: string; ownerToken?: string })
          : {};
        const result = await handler(body);
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(JSON.stringify(result.json));
      })();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/`, posts: () => posts });
    });
  });
}

async function prepListen(uploadId: string, text: string): Promise<void> {
  const { uploadFile } = await import("@/lib/storage");
  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  await uploadFile(`pdfs/${uploadId}`, "listen-cleaned.txt", Buffer.from(text), "text/plain");
  await uploadFile(
    `pdfs/${uploadId}`,
    "listen-prep.json",
    Buffer.from(
      JSON.stringify({
        status: "done",
        sourceHash: hash,
        narratorSettled: true,
        protectedHeadings: true,
        notes: [],
        narrator: null,
        model: "test",
      })
    ),
    "application/json"
  );
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

beforeEach(async () => {
  resetModalWorkspaceDisabled();
  await resetDatabase();
  delete process.env.CPU_RUNNER;
  delete process.env.MODAL_CPU_URL;
  delete process.env.CPU_DISPATCH_ACCEPT_MS;
  delete process.env.CPU_DISPATCH_BUSY_MS;
  delete process.env.CPU_PLACEMENT_LEASE_S;
  delete process.env.TAKEHOME_GLOBAL_ACTIVE;
  delete process.env.TAKEHOME_MAX_INFLIGHT_PER_USER;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CPU_RUNNER;
  delete process.env.MODAL_CPU_URL;
  delete process.env.CPU_DISPATCH_ACCEPT_MS;
  delete process.env.CPU_DISPATCH_BUSY_MS;
  delete process.env.CPU_PLACEMENT_LEASE_S;
  delete process.env.TTS_SECTION_MASTER;
  delete process.env.WORKER;
  delete process.env.TTS_SECTION_QA_ENABLED;
  delete process.env.TAKEHOME_GLOBAL_ACTIVE;
  delete process.env.TAKEHOME_MAX_INFLIGHT_PER_USER;
});

describe("cpu budgets", () => {
  it("keeps the accept wait far under the section budget, and concat longer than a section", () => {
    expect(cpuDispatchAcceptMs({})).toBe(20_000);
    expect(cpuSectionBudgetSeconds({})).toBe(900);
    expect(cpuConcatBudgetSeconds({})).toBe(3_600);
    expect(cpuDispatchAcceptMs({})).toBeLessThan(cpuSectionBudgetSeconds({}) * 1000);
    expect(cpuConcatBudgetSeconds({})).toBeGreaterThan(cpuSectionBudgetSeconds({}));
    const source = readFileSync(path.join(process.cwd(), "modal/cpu_worker.py"), "utf8");
    expect(source).toContain("CPU_CONCAT_TIMEOUT_S");
    expect(source).toContain("ownerToken");
    expect(source).toContain("FUNCTION_TIMEOUT_S");
    expect(source).toContain("min_containers=0");
    expect(source).not.toMatch(/\bgpu\s*=/);
    expect(effectiveOrchestratorConcurrency({ WORKER_CONCURRENCY: "6" })).toBe(1);
    expect(effectiveOrchestratorConcurrency({ CPU_RUNNER: "modal" })).toBeGreaterThan(1);
  });
});

describe("modal placement", () => {
  it("does not start a second container when the accept times out, and keeps the late success", async () => {
    process.env.CPU_RUNNER = "modal";
    process.env.CPU_DISPATCH_ACCEPT_MS = "400";
    process.env.CPU_PLACEMENT_LEASE_S = "60";
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    const live = await listen(async (body) => {
      seen.push(body.ownerToken || "");
      await gate;
      if (body.taskId && body.ownerToken) {
        await completeCpuTask(body.taskId, body.ownerToken);
      }
      return { status: 200, json: { ok: true } };
    });
    process.env.MODAL_CPU_URL = live.url;
    try {
      await enqueueCpuTask({
        id: "master:job-timeout:0",
        kind: "master",
        jobId: "job-timeout",
        sectionIndex: 0,
        inputPath: "audiobooks/job-timeout/raw/0000.wav",
        outputPath: "audiobooks/job-timeout/sections/0000.mp3",
      });
      const first = await runCpuTask("master:job-timeout:0");
      expect(first).toBe("accepted");
      expect(live.posts()).toBe(1);
      const placed = await getCpuTask("master:job-timeout:0");
      expect(placed?.status).toBe("claimed");
      expect(placed?.owner_token).toBeTruthy();
      const second = await runCpuTask("master:job-timeout:0");
      expect(second).toBe("accepted");
      expect(live.posts()).toBe(1);
      release?.();
      await vi.waitFor(async () => {
        expect((await getCpuTask("master:job-timeout:0"))?.status).toBe("done");
      });
      const late = await runCpuTask("master:job-timeout:0");
      expect(late).toBe("done");
      expect(live.posts()).toBe(1);
      expect(await completeCpuTask("master:job-timeout:0", "someone-else")).toBe(false);
    } finally {
      release?.();
      await close(live.server);
    }
  });

  it("lets only one of two overlapping callers post", async () => {
    process.env.CPU_RUNNER = "modal";
    process.env.CPU_DISPATCH_ACCEPT_MS = "5000";
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const live = await listen(async () => {
      await gate;
      return { status: 202, json: { ok: true, accepted: true } };
    });
    process.env.MODAL_CPU_URL = live.url;
    try {
      await enqueueCpuTask({
        id: "master:job-race:0",
        kind: "master",
        jobId: "job-race",
        sectionIndex: 0,
      });
      const both = Promise.all([
        runCpuTask("master:job-race:0"),
        runCpuTask("master:job-race:0"),
      ]);
      await vi.waitFor(() => expect(live.posts()).toBe(1));
      release?.();
      const results = await both;
      expect(live.posts()).toBe(1);
      expect(results.every((result) => result === "accepted" || result === "deferred")).toBe(true);
      expect(results.filter((result) => result === "accepted").length).toBeGreaterThan(0);
      const row = await getCpuTask("master:job-race:0");
      expect(row?.status === "claimed" || row?.status === "queued").toBe(true);
    } finally {
      release?.();
      await close(live.server);
    }
  });

  it("rejects a completed HTTP 500 instead of treating it as accepted", async () => {
    process.env.CPU_RUNNER = "modal";
    process.env.CPU_DISPATCH_ACCEPT_MS = "2000";
    const live = await listen(async () => ({ status: 500, json: { ok: false } }));
    process.env.MODAL_CPU_URL = live.url;
    try {
      await enqueueCpuTask({
        id: "concat:job-500",
        kind: "concat",
        jobId: "job-500",
        outputPath: "audiobooks/job-500/full.mp3",
      });
      const result = await runCpuTask("concat:job-500");
      expect(result).toBe("failed");
      const row = await getCpuTask("concat:job-500");
      expect(row?.status).toBe("failed");
      expect(row?.owner_token).toBeNull();
      expect(row?.lease_expires_at).toBeNull();
      expect(Number(row?.attempts)).toBe(0);
      expect(String(row?.error_message)).toMatch(/HTTP 500/);
      const again = await runCpuTask("concat:job-500");
      expect(again).toBe("failed");
      expect(live.posts()).toBe(1);
    } finally {
      await close(live.server);
    }
  });

  it("does not accept a disabled-workspace 404 or spend an attempt", async () => {
    process.env.CPU_RUNNER = "modal";
    process.env.CPU_DISPATCH_ACCEPT_MS = "2000";
    const live = await listen(async () => ({
      status: 404,
      json: { error: "workspace ac-disabledtest is disabled." },
    }));
    process.env.MODAL_CPU_URL = live.url;
    try {
      await enqueueCpuTask({
        id: "master:job-disabled:113",
        kind: "master",
        jobId: "job-disabled",
        sectionIndex: 113,
        inputPath: "audiobooks/job-disabled/raw/0113.mp3",
        outputPath: "audiobooks/job-disabled/sections/0113.mp3",
      });
      await enqueueCpuTask({
        id: "master:job-disabled:120",
        kind: "master",
        jobId: "job-disabled",
        sectionIndex: 120,
        inputPath: "audiobooks/job-disabled/raw/0120.mp3",
        outputPath: "audiobooks/job-disabled/sections/0120.mp3",
      });
      expect(await runCpuTask("master:job-disabled:113")).toBe("unavailable");
      const row = await getCpuTask("master:job-disabled:113");
      expect(row?.status).toBe("queued");
      expect(Number(row?.attempts)).toBe(0);
      expect(row?.started_at ?? null).toBeNull();
      expect(String(row?.error_message)).toMatch(/workspace disabled/);
      expect(await runCpuTask("master:job-disabled:120")).toBe("unavailable");
      expect((await getCpuTask("master:job-disabled:120"))?.status).toBe("queued");
      expect(live.posts()).toBe(1);
    } finally {
      await close(live.server);
      resetModalWorkspaceDisabled();
    }
  });

  it("rejects a plain HTTP 404 and does not post it again", async () => {
    process.env.CPU_RUNNER = "modal";
    process.env.CPU_DISPATCH_ACCEPT_MS = "2000";
    const live = await listen(async () => ({ status: 404, json: { ok: false } }));
    process.env.MODAL_CPU_URL = live.url;
    try {
      await enqueueCpuTask({
        id: "master:job-404:0",
        kind: "master",
        jobId: "job-404",
        sectionIndex: 0,
      });
      expect(await runCpuTask("master:job-404:0")).toBe("failed");
      const row = await getCpuTask("master:job-404:0");
      expect(row?.status).toBe("failed");
      expect(Number(row?.attempts)).toBe(0);
      expect(await runCpuTask("master:job-404:0")).toBe("failed");
      expect(live.posts()).toBe(1);
    } finally {
      await close(live.server);
    }
  });

  it("does not resurrect an exhausted concat row into a runnable queue", async () => {
    const id = "concat:job-exhausted";
    await enqueueCpuTask({
      id,
      kind: "concat",
      jobId: "job-exhausted",
      inputPath: "audiobooks/job-exhausted",
      outputPath: "audiobooks/job-exhausted/full.mp3",
    });
    await execute(
      `UPDATE cpu_tasks SET status = 'queued', attempts = 3, finished_at = 1794116698,
         error_message = NULL, started_at = NULL WHERE id = ?`,
      [id]
    );
    await enqueueCpuTask({
      id,
      kind: "concat",
      jobId: "job-exhausted",
      inputPath: "audiobooks/job-exhausted",
      outputPath: "audiobooks/job-exhausted/full.mp3",
    });
    const row = await getCpuTask(id);
    expect(row?.status).toBe("failed");
    expect(Number(row?.attempts)).toBe(3);
    expect(Number(row?.finished_at)).toBe(1794116698);
    expect(row?.error_message).toBeTruthy();
  });

  it("releases a busy container so a later placement can post once", async () => {
    process.env.CPU_RUNNER = "modal";
    process.env.CPU_DISPATCH_BUSY_MS = "0";
    let busy = true;
    const live = await listen(async (body) => {
      if (busy) return { status: 429, json: { ok: false, deferred: true } };
      if (body.taskId && body.ownerToken) await completeCpuTask(body.taskId, body.ownerToken);
      return { status: 200, json: { ok: true } };
    });
    process.env.MODAL_CPU_URL = live.url;
    try {
      await enqueueCpuTask({
        id: "master:job-429:0",
        kind: "master",
        jobId: "job-429",
        sectionIndex: 0,
      });
      expect(await runCpuTask("master:job-429:0")).toBe("deferred");
      expect((await getCpuTask("master:job-429:0"))?.status).toBe("queued");
      busy = false;
      expect(await runCpuTask("master:job-429:0")).toBe("done");
      expect(live.posts()).toBe(2);
    } finally {
      await close(live.server);
    }
  });

  it("posts again while the first container is still busy", async () => {
    process.env.CPU_RUNNER = "modal";
    process.env.CPU_DISPATCH_BUSY_MS = "2000";
    let posts = 0;
    const live = await listen(async (body) => {
      posts += 1;
      if (posts === 1) return { status: 429, json: { ok: false, deferred: true } };
      if (body.taskId && body.ownerToken) await completeCpuTask(body.taskId, body.ownerToken);
      return { status: 200, json: { ok: true } };
    });
    process.env.MODAL_CPU_URL = live.url;
    try {
      await enqueueCpuTask({
        id: "master:job-overlap:1",
        kind: "master",
        jobId: "job-overlap",
        sectionIndex: 1,
      });
      expect(await runCpuTask("master:job-overlap:1")).toBe("done");
      expect(live.posts()).toBe(2);
      expect((await getCpuTask("master:job-overlap:1"))?.status).toBe("done");
    } finally {
      await close(live.server);
    }
  });

  it("reclaims an expired placement after the caller is gone and fences the old owner", async () => {
    process.env.CPU_RUNNER = "modal";
    process.env.CPU_DISPATCH_ACCEPT_MS = "300";
    const live = await listen(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      return { status: 200, json: { ok: true } };
    });
    process.env.MODAL_CPU_URL = live.url;
    try {
      await enqueueCpuTask({
        id: "master:job-dead:0",
        kind: "master",
        jobId: "job-dead",
        sectionIndex: 0,
      });
      expect(await runCpuTask("master:job-dead:0")).toBe("accepted");
      const owner = (await getCpuTask("master:job-dead:0"))?.owner_token || "";
      expect(owner).not.toBe("");
      await execute(
        `UPDATE cpu_tasks SET lease_expires_at = unixepoch() - 1 WHERE id = ?`,
        ["master:job-dead:0"]
      );
      expect(await requeueExpiredCpuTasks()).toBe(1);
      expect((await getCpuTask("master:job-dead:0"))?.status).toBe("queued");
      expect(await completeCpuTask("master:job-dead:0", owner)).toBe(false);
    } finally {
      await close(live.server);
    }
  });
});

describe("a remote cpu wait does not block another book", () => {
  it("synthesizes a second book while the first container has not finished", async () => {
    process.env.TTS_SECTION_MASTER = "1";
    process.env.WORKER = "1";
    process.env.TTS_SECTION_QA_ENABLED = "0";
    process.env.CPU_RUNNER = "modal";
    process.env.CPU_DISPATCH_ACCEPT_MS = "400";
    process.env.CPU_YIELD_SEC = "30";
    const live = await listen(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      return { status: 202, json: { ok: true, accepted: true } };
    });
    process.env.MODAL_CPU_URL = live.url;
    const text = "The harbor was quiet after the rain.";
    const idA = "55555555-5555-4555-8555-555555555555";
    const idB = "66666666-6666-4666-8666-666666666666";
    const pathA = await seedUpload({ id: idA, userId: USER_A, text });
    const pathB = await seedUpload({ id: idB, userId: USER_B, text });
    await prepListen(idA, text);
    await prepListen(idB, text);
    await seedJob({
      id: "job-wait-cpu",
      userId: USER_A,
      pdfStoragePath: pathA,
      ttsProvider: "openrouter",
      providerVoiceId: "Achernar",
      catalogVoiceId: "standard",
    });
    await seedJob({
      id: "job-other",
      userId: USER_B,
      pdfStoragePath: pathB,
      ttsProvider: "openrouter",
      providerVoiceId: "Achernar",
      catalogVoiceId: "standard",
    });
    const providers = await import("@/lib/tts/providers");
    const fake = createFakeProvider(() => ({ audio: toneWav(), contentType: "audio/wav" }));
    vi.spyOn(providers, "resolveStockAdapter").mockReturnValue(fake);
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    try {
      const started = Date.now();
      const waiting = await processTakehomeTick("job-wait-cpu", {
        sectionsPerTick: 1,
        deadlineMs: Date.now() + 30_000,
      });
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(waiting.done).toBe(false);
      expect(waiting.yieldSlot).toBe(true);
      const waitingRow = await jobRow("job-wait-cpu");
      expect(waitingRow?.status).toBe("queued");
      const segments = JSON.parse(String(waitingRow?.segments_json)) as Array<{
        status: string;
        rawPath?: string;
      }>;
      expect(segments[0]?.status).toBe("mastering");
      expect(segments[0]?.rawPath).toMatch(/\/raw\//);
      expect(await fileExists(String(segments[0]?.rawPath))).toBe(true);
      expect(await fileExists("audiobooks/job-wait-cpu/sections/0000.mp3")).toBe(false);
      const callsAfterWait = fake.calls.length;
      expect(callsAfterWait).toBeGreaterThan(0);
      delete process.env.CPU_RUNNER;
      delete process.env.TTS_SECTION_MASTER;
      const other = await processTakehomeTick("job-other", {
        sectionsPerTick: 1,
        deadlineMs: Date.now() + 60_000,
      });
      expect(other.done).toBe(true);
      expect((await jobRow("job-other"))?.status).toBe("ready");
      expect(fake.calls.length).toBe(callsAfterWait + 1);
      const still = JSON.parse(String((await jobRow("job-wait-cpu"))?.segments_json)) as Array<{
        status: string;
      }>;
      expect(still[0]?.status).toBe("mastering");
      expect(live.posts()).toBe(1);
    } finally {
      await close(live.server);
    }
  }, 90_000);
});

describe("raw audio is not spoken again", () => {
  it("masters an uploaded raw take when the segment row was never saved", async () => {
    process.env.TTS_SECTION_MASTER = "1";
    process.env.WORKER = "1";
    process.env.TTS_SECTION_QA_ENABLED = "0";
    const text = "The harbor was quiet after the rain.";
    const uploadId = "77777777-7777-4777-8777-777777777777";
    const pdfPath = await seedUpload({
      id: uploadId,
      userId: USER_A,
      text,
    });
    await prepListen(uploadId, text);
    await seedJob({
      id: "job-orphan",
      userId: USER_A,
      pdfStoragePath: pdfPath,
      ttsProvider: "openrouter",
      providerVoiceId: "Achernar",
      catalogVoiceId: "standard",
    });
    const { uploadFile } = await import("@/lib/storage");
    await uploadFile(
      "audiobooks/job-orphan/raw",
      "0000.wav",
      toneWav(),
      "audio/wav"
    );
    const providers = await import("@/lib/tts/providers");
    const fake = createFakeProvider(() => {
      throw new Error("raw take must not be synthesized again");
    });
    vi.spyOn(providers, "resolveStockAdapter").mockReturnValue(fake);
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    const result = await processTakehomeTick("job-orphan", {
      sectionsPerTick: 1,
      deadlineMs: Date.now() + 60_000,
    });
    expect(result.done).toBe(true);
    expect(fake.calls).toHaveLength(0);
    const row = await jobRow("job-orphan");
    expect(row?.status).toBe("ready");
    const segments = JSON.parse(String(row?.segments_json)) as Array<{
      status: string;
      mastered?: boolean;
      path: string;
      rawPath?: string;
    }>;
    expect(segments[0]?.status).toBe("ready");
    expect(segments[0]?.mastered).toBe(true);
    expect(segments[0]?.rawPath).toBe("audiobooks/job-orphan/raw/0000.wav");
    expect(await fileExists(String(segments[0]?.path))).toBe(true);
    expect(await fileExists(String(segments[0]?.rawPath))).toBe(true);
  }, 90_000);
});

describe("cluster admission", () => {
  it("stops a third book while two synthesis leases are live", async () => {
    process.env.TAKEHOME_GLOBAL_ACTIVE = "2";
    process.env.TAKEHOME_MAX_INFLIGHT_PER_USER = "2";
    const { claimTakehomeLease } = await import("@/lib/tts/process-job");
    for (const [id, user] of [
      ["cap-a", USER_A],
      ["cap-b", USER_B],
      ["cap-c", USER_C],
    ] as const) {
      const pdfPath = await seedUpload({
        id: `88888888-8888-4888-8888-88888888888${id === "cap-a" ? "1" : id === "cap-b" ? "2" : "3"}`,
        userId: user,
        text: "Short.",
      });
      await seedJob({
        id,
        userId: user,
        pdfStoragePath: pdfPath,
        ttsProvider: "openrouter",
        providerVoiceId: "Achernar",
        catalogVoiceId: "standard",
      });
    }
    expect(await claimTakehomeLease("cap-a")).toBeTruthy();
    expect(await claimTakehomeLease("cap-b")).toBeTruthy();
    expect(await claimTakehomeLease("cap-c")).toBeNull();
    const rows = await query<{ id: string; status: string }>(
      `SELECT id, status FROM jobs WHERE id LIKE 'cap-%' ORDER BY id`
    );
    expect(rows.filter((row) => row.status === "processing")).toHaveLength(2);
    expect(rows.find((row) => row.id === "cap-c")?.status).toBe("queued");
  });

  it("runs two worker loops across users without stacking local cpu slots", async () => {
    process.env.TTS_SECTION_QA_ENABLED = "0";
    process.env.TAKEHOME_MAX_INFLIGHT_PER_USER = "1";
    process.env.TAKEHOME_GLOBAL_ACTIVE = "2";
    delete process.env.CPU_RUNNER;
    expect(effectiveOrchestratorConcurrency(process.env)).toBe(1);
    const users = [USER_A, USER_B, USER_C, USER_D];
    const text = "The harbor was quiet after the rain.";
    const paths: string[] = [];
    for (let i = 0; i < users.length; i++) {
      const uploadId = `9999999${i}-9999-4999-8999-999999999999`;
      paths.push(await seedUpload({ id: uploadId, userId: users[i]!, text }));
      await prepListen(uploadId, text);
    }
    const userById = new Map<string, string>();
    for (let i = 0; i < 8; i++) {
      const id = `fleet-${i}`;
      const userId = users[i % users.length]!;
      userById.set(id, userId);
      await seedJob({
        id,
        userId,
        pdfStoragePath: paths[i % users.length]!,
        ttsProvider: "openrouter",
        providerVoiceId: "Achernar",
        catalogVoiceId: "standard",
      });
    }
    const providers = await import("@/lib/tts/providers");
    let active = 0;
    let maxActive = 0;
    let releaseFleet: (() => void) | null = null;
    const fleetGate = new Promise<void>((resolve) => {
      releaseFleet = resolve;
    });
    let entered = 0;
    const fake = createFakeProvider(async () => {
      entered += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (entered >= 2) releaseFleet?.();
      await fleetGate;
      active -= 1;
      return { audio: fakeMp3(), contentType: "audio/mpeg" };
    });
    vi.spyOn(providers, "resolveStockAdapter").mockReturnValue(fake);
    const { TakehomeWorkerLoop } = await import("@/worker/takehome-loop");
    const {
      listDrainableTakehomeJobs,
      releaseExpiredTakehomeLeases,
      runTakehomeUntilSettled,
    } = await import("@/lib/tts/process-job");
    const runner = {
      runUntilSettled: runTakehomeUntilSettled,
      listDrainable: listDrainableTakehomeJobs,
      releaseExpired: releaseExpiredTakehomeLeases,
    };
    const loopA = new TakehomeWorkerLoop({
      concurrency: 1,
      budgetMs: 60_000,
      runner,
      log: { info: () => {}, error: () => {} },
    });
    const loopB = new TakehomeWorkerLoop({
      concurrency: 1,
      budgetMs: 60_000,
      runner,
      log: { info: () => {}, error: () => {} },
    });
    const started = Date.now();
    while (Date.now() - started < 90_000) {
      await Promise.all([loopA.drain(), loopB.drain()]);
      const rows = await query<{ status: string; n: number }>(
        `SELECT status, COUNT(*) AS n FROM jobs WHERE id LIKE 'fleet-%' GROUP BY status`
      );
      const ready = Number(rows.find((row) => row.status === "ready")?.n || 0);
      const failed = Number(rows.find((row) => row.status === "failed")?.n || 0);
      if (ready + failed === 8 && loopA.inflightCount === 0 && loopB.inflightCount === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    loopA.stop();
    loopB.stop();
    const rows = await query<{ id: string; status: string; user_id: string; audio_storage_path: string | null }>(
      `SELECT id, status, user_id, audio_storage_path FROM jobs WHERE id LIKE 'fleet-%'`
    );
    expect(rows.filter((row) => row.status === "failed")).toHaveLength(0);
    expect(rows.filter((row) => row.status === "ready")).toHaveLength(8);
    expect(new Set(rows.map((row) => row.audio_storage_path)).size).toBe(8);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(new Set(rows.map((row) => row.user_id)).size).toBe(4);
  }, 120_000);
});

describe("section publish stays unpublished until the task is done", () => {
  it("leaves mastering set when the remote task has only been accepted", async () => {
    process.env.TTS_SECTION_MASTER = "1";
    process.env.WORKER = "1";
    process.env.CPU_RUNNER = "modal";
    process.env.CPU_DISPATCH_ACCEPT_MS = "300";
    const live = await listen(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      return { status: 500, json: { ok: false } };
    });
    process.env.MODAL_CPU_URL = live.url;
    try {
      const committed = await commitSectionAudio({
        jobId: "job-accept",
        index: 0,
        audio: toneWav(),
        extension: "wav",
        contentType: "audio/wav",
        chain: "podcast",
        qaDeferred: false,
      });
      expect(committed.ready).toBe(false);
      expect(committed.rawPath).toBe("audiobooks/job-accept/raw/0000.wav");
      expect(await fileExists("audiobooks/job-accept/sections/0000.mp3")).toBe(false);
      const promoted = await promoteFinishedSections("job-accept", [
        { index: 0, path: "", status: "mastering", rawPath: committed.rawPath },
      ]);
      expect(promoted.waiting).toBe(true);
      expect(promoted.segments[0]?.status).toBe("mastering");
      expect(live.posts()).toBe(1);
    } finally {
      await close(live.server);
    }
  });
});
