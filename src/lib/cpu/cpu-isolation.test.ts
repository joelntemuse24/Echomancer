/**
 * CPU isolation. No provider, GPU, or Modal calls. ffmpeg runs only when
 * it is already on PATH. A 200-job burst uses the fake speech provider.
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  USER_A,
  USER_B,
  createFakeProvider,
  jobRow,
  resetDatabase,
  seedJob,
  seedUpload,
} from "@/test/harness";
import { execute, query, queryOne } from "@/lib/turso";
import { fileExists } from "@/lib/storage";
import { commitSectionAudio, promoteFinishedSections } from "@/lib/cpu/section-publish";
import {
  claimCpuTask,
  enqueueCpuTask,
  getCpuTask,
  heartbeatCpuTask,
} from "@/lib/cpu/tasks";
import { runCpuTask } from "@/lib/cpu/runner";
import { ffmpegCpuCap, tryCpuSlot } from "@/lib/cpu/task-slot";
import { shouldSectionMaster } from "@/lib/tts/section-master";

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

function listen(handler: (body: { taskId?: string }) => Promise<{ status: number; json: unknown }>): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      void (async () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const body = raw ? (JSON.parse(raw) as { taskId?: string }) : {};
        const result = await handler(body);
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(JSON.stringify(result.json));
      })();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

beforeEach(async () => {
  await resetDatabase();
  delete process.env.CPU_RUNNER;
  delete process.env.MODAL_CPU_URL;
  delete process.env.TTS_SECTION_MASTER;
  delete process.env.WORKER;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CPU_RUNNER;
  delete process.env.MODAL_CPU_URL;
  delete process.env.TTS_SECTION_MASTER;
  delete process.env.WORKER;
  delete process.env.TTS_SECTION_QA_ENABLED;
  delete process.env.TAKEHOME_MAX_INFLIGHT_PER_USER;
});

describe("modal cpu contract", () => {
  it("is a scale-to-zero CPU app, separate from the GPU app", () => {
    const source = readFileSync(path.join(process.cwd(), "modal/cpu_worker.py"), "utf8");
    const docker = readFileSync(path.join(process.cwd(), "workers/cpu/Dockerfile"), "utf8");
    const once = readFileSync(path.join(process.cwd(), "src/worker/cpu-once.ts"), "utf8");
    expect(source).toContain('echomancer-cpu');
    expect(source).toContain('modal.App(APP_NAME)');
    expect(source).not.toMatch(/modal\.App\(\s*["']echomancer-s2/);
    expect(source).toContain("min_containers=0");
    expect(source).toContain("max_containers=MAX_CONTAINERS");
    expect(source).toContain("scaledown_window=SCALEDOWN_S");
    expect(source).not.toMatch(/\bgpu\s*=/);
    expect(source).toContain("cpu-once.ts");
    expect(source).toContain("context_dir=_ROOT");
    expect(source).toContain('.pip_install("fastapi[standard]==0.115.6")');
    expect(source).not.toMatch(/add_python\s*=/);
    expect(source).toContain("429");
    expect(docker).toContain("ffmpeg");
    expect(docker).toContain("python-is-python3");
    expect(docker).toContain("faster-whisper==1.1.1");
    expect(docker).toContain("TTS_QA_WHISPER_PYTHON=/usr/bin/python3");
    expect(docker).toContain("python -VV");
    expect(docker).not.toContain("snapshot_download");
    expect(docker).not.toContain("fastapi==");
    expect(once).toContain("CPU_RUNNER");
    for (const kind of ["master", "whisper", "concat", "extract"]) {
      expect(readFileSync(path.join(process.cwd(), "src/lib/cpu/runner.ts"), "utf8")).toContain(
        `"${kind}"`
      );
    }
  });

  it("rejects an endpoint URL that has a path, without calling it", async () => {
    process.env.CPU_RUNNER = "modal";
    process.env.MODAL_CPU_URL = "https://example.modal.run/run";
    await enqueueCpuTask({ id: "master:job:0", kind: "master", jobId: "job", sectionIndex: 0 });
    await expect(runCpuTask("master:job:0")).rejects.toThrow(/no path/);
  });
});

describe("unmastered audio is not published", () => {
  it("keeps the raw object and leaves the section key absent when the host is full", async () => {
    process.env.TTS_SECTION_MASTER = "1";
    process.env.WORKER = "1";
    expect(shouldSectionMaster()).toBe(true);
    const held = [];
    for (let i = 0; i < ffmpegCpuCap(); i++) {
      const slot = await tryCpuSlot("ffmpeg", 0);
      expect(slot).not.toBeNull();
      expect(slot).not.toBe("unavailable");
      held.push(slot);
    }
    try {
      const committed = await commitSectionAudio({
        jobId: "job-saturated",
        index: 0,
        audio: toneWav(),
        extension: "wav",
        contentType: "audio/wav",
        chain: "podcast",
        qaDeferred: false,
      });
      expect(committed.ready).toBe(false);
      expect(committed.mastered).toBe(false);
      expect(committed.path).toBe("");
      expect(committed.rawPath).toBe("audiobooks/job-saturated/raw/0000.wav");
      expect(await fileExists(committed.rawPath!)).toBe(true);
      expect(await fileExists("audiobooks/job-saturated/sections/0000.mp3")).toBe(false);
      const task = await getCpuTask("master:job-saturated:0");
      expect(task?.status).toBe("queued");
    } finally {
      for (const slot of held) {
        if (slot && slot !== "unavailable") await slot.release();
      }
    }
  });

  it("does not publish after the job is cancelled", async () => {
    await seedJob({
      id: "job-cancel-cpu",
      userId: USER_A,
      pdfStoragePath: "pdfs/cancel/content.txt",
    });
    await execute(`UPDATE jobs SET status = 'cancelled' WHERE id = ?`, ["job-cancel-cpu"]);
    await enqueueCpuTask({
      id: "master:job-cancel-cpu:0",
      kind: "master",
      jobId: "job-cancel-cpu",
      sectionIndex: 0,
      inputPath: "audiobooks/job-cancel-cpu/raw/0000.wav",
      outputPath: "audiobooks/job-cancel-cpu/sections/0000.mp3",
      payload: { extension: "wav", chain: "podcast" },
    });
    expect(await runCpuTask("master:job-cancel-cpu:0")).toBe("cancelled");
    expect(await fileExists("audiobooks/job-cancel-cpu/sections/0000.mp3")).toBe(false);
    expect((await getCpuTask("master:job-cancel-cpu:0"))?.status).toBe("cancelled");
  });

  it("renews a live claim and lets the next owner take an expired one", async () => {
    await enqueueCpuTask({
      id: "master:job-beat:0",
      kind: "master",
      jobId: "job-beat",
      sectionIndex: 0,
    });
    expect(await claimCpuTask("master:job-beat:0", "owner-a", 30)).toBe(true);
    expect(await claimCpuTask("master:job-beat:0", "owner-b", 30)).toBe(false);
    await execute(
      `UPDATE cpu_tasks SET lease_expires_at = unixepoch() + 5 WHERE id = ?`,
      ["master:job-beat:0"]
    );
    const before = await getCpuTask("master:job-beat:0");
    expect(await heartbeatCpuTask("master:job-beat:0", "owner-a", 90)).toBe(true);
    const after = await getCpuTask("master:job-beat:0");
    expect(Number(after?.lease_expires_at)).toBeGreaterThan(Number(before?.lease_expires_at));
    expect(await heartbeatCpuTask("master:job-beat:0", "owner-b", 90)).toBe(false);
    await execute(`UPDATE cpu_tasks SET lease_expires_at = unixepoch() - 1 WHERE id = ?`, [
      "master:job-beat:0",
    ]);
    expect(await claimCpuTask("master:job-beat:0", "owner-b", 30)).toBe(true);
    expect(await completeCpuTaskStolen("master:job-beat:0", "owner-a")).toBe(false);
  });
});

async function completeCpuTaskStolen(id: string, owner: string): Promise<boolean> {
  const { completeCpuTask } = await import("@/lib/cpu/tasks");
  return completeCpuTask(id, owner);
}

describe("two processes", () => {
  it("lets one process claim a task and the other recover it after the lease expires", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "echo-cpu-"));
    const url = `file:${path.join(dir, "cpu.db")}`;
    const client = createClient({ url });
    await client.execute("PRAGMA busy_timeout = 5000");
    await client.execute(`
      CREATE TABLE cpu_tasks (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        job_id TEXT,
        upload_id TEXT,
        section_index INTEGER,
        status TEXT NOT NULL,
        owner_token TEXT,
        lease_expires_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        input_path TEXT,
        output_path TEXT,
        payload_json TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`);
    await client.execute({
      sql: `INSERT INTO cpu_tasks (id, kind, status) VALUES ('master:race:0', 'master', 'queued')`,
    });
    const tsx = path.join(process.cwd(), "node_modules/.bin/tsx");
    const child = path.join(process.cwd(), "src/lib/cpu/cpu-child.ts");
    const run = (args: string[]) =>
      new Promise<string>((resolve, reject) => {
        const proc = spawn(tsx, [child, ...args], { env: { ...process.env, VITEST: "1" } });
        let out = "";
        proc.stdout.on("data", (chunk) => {
          out += chunk.toString();
        });
        proc.on("error", reject);
        proc.on("close", (code) => {
          if (code !== 0) reject(new Error(out || `exit ${code}`));
          else resolve(out.trim().split("\n").pop() || "");
        });
      });
    const [first, second] = await Promise.all([
      run(["claim", url, "master:race:0"]),
      run(["claim", url, "master:race:0"]),
    ]);
    const wins = [JSON.parse(first), JSON.parse(second)].filter((row) => row.claimed === true);
    expect(wins).toHaveLength(1);
    await client.execute(
      "UPDATE cpu_tasks SET lease_expires_at = unixepoch() - 1 WHERE id = 'master:race:0'"
    );
    const recovered = JSON.parse(await run(["claim", url, "master:race:0"]));
    expect(recovered.claimed).toBe(true);
    client.close();
  });
});

describe("modal dispatch", () => {
  it("leaves the section unpublished on 429 and publishes when the worker finishes", async () => {
    process.env.TTS_SECTION_MASTER = "1";
    process.env.WORKER = "1";
    expect(shouldSectionMaster()).toBe(true);
    let mode: "busy" | "done" = "busy";
    const live = await listen(async (body) => {
      if (mode === "busy") return { status: 429, json: { ok: false, deferred: true } };
      const id = body.taskId || "";
      const row = await queryOne<{ output_path: string | null }>(
        `SELECT output_path FROM cpu_tasks WHERE id = ?`,
        [id]
      );
      if (row?.output_path) {
        const { uploadFile } = await import("@/lib/storage");
        const slash = row.output_path.lastIndexOf("/");
        await uploadFile(
          row.output_path.slice(0, slash),
          row.output_path.slice(slash + 1),
          Buffer.from("mastered-bytes"),
          "audio/mpeg"
        );
      }
      await execute(
        `UPDATE cpu_tasks SET status = 'done', owner_token = NULL, lease_expires_at = NULL WHERE id = ?`,
        [id]
      );
      return { status: 200, json: { ok: true } };
    });
    process.env.CPU_RUNNER = "modal";
    process.env.MODAL_CPU_URL = live.url;
    try {
      const first = await commitSectionAudio({
        jobId: "job-modal",
        index: 0,
        audio: toneWav(),
        extension: "wav",
        contentType: "audio/wav",
        chain: "podcast",
        qaDeferred: false,
      });
      expect(first.ready).toBe(false);
      expect(await fileExists("audiobooks/job-modal/raw/0000.wav")).toBe(true);
      expect(await fileExists("audiobooks/job-modal/sections/0000.mp3")).toBe(false);
      mode = "done";
      const promoted = await promoteFinishedSections("job-modal", [
        { index: 0, path: "", status: "mastering", rawPath: first.rawPath },
      ]);
      expect(promoted.waiting).toBe(false);
      expect(promoted.segments[0]?.status).toBe("ready");
      expect(promoted.segments[0]?.mastered).toBe(true);
      expect(promoted.segments[0]?.path).toBe("audiobooks/job-modal/sections/0000.mp3");
      expect(await fileExists("audiobooks/job-modal/sections/0000.mp3")).toBe(true);
    } finally {
      await new Promise<void>((resolve) => live.server.close(() => resolve()));
    }
  });
});

describe("synthetic book", () => {
  it("masters and joins a generated tone without a provider", async () => {
    process.env.TTS_SECTION_MASTER = "1";
    process.env.WORKER = "1";
    process.env.TTS_SECTION_QA_ENABLED = "0";
    expect(shouldSectionMaster()).toBe(true);
    const pdfPath = await seedUpload({
      id: "33333333-3333-4333-8333-333333333333",
      userId: USER_A,
      text: "The harbor was quiet after the rain.",
    });
    await seedJob({
      id: "job-tone",
      userId: USER_A,
      pdfStoragePath: pdfPath,
      ttsProvider: "openrouter",
      providerVoiceId: "Achernar",
      catalogVoiceId: "standard",
    });
    const providers = await import("@/lib/tts/providers");
    const fake = createFakeProvider(() => ({
      audio: toneWav(),
      contentType: "audio/wav",
    }));
    vi.spyOn(providers, "resolveStockAdapter").mockReturnValue(fake);
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    const result = await processTakehomeTick("job-tone", {
      sectionsPerTick: 2,
      deadlineMs: Date.now() + 120_000,
    });
    expect(result.done).toBe(true);
    const row = await jobRow("job-tone");
    expect(row?.status).toBe("ready");
    const segments = JSON.parse(String(row?.segments_json)) as Array<{
      status: string;
      mastered?: boolean;
      path: string;
      rawPath?: string;
    }>;
    expect(segments.every((segment) => segment.status === "ready" && segment.mastered)).toBe(true);
    expect(segments[0]?.rawPath).toMatch(/\/raw\//);
    expect(segments[0]?.path).not.toBe(segments[0]?.rawPath);
    expect(await fileExists(String(segments[0]?.path))).toBe(true);
    expect(await fileExists(String(segments[0]?.rawPath))).toBe(true);
    const { downloadFile } = await import("@/lib/storage");
    const published = await downloadFile(String(segments[0]?.path));
    const raw = await downloadFile(String(segments[0]?.rawPath));
    expect(published.equals(raw)).toBe(false);
    expect(String(row?.audio_storage_path)).toContain("full.mp3");
    expect(fake.calls.length).toBeGreaterThan(0);
  }, 120_000);
});

describe("200-job burst", () => {
  it("finishes every fake book with fair, bounded progress", async () => {
    process.env.TTS_SECTION_QA_ENABLED = "0";
    process.env.TAKEHOME_MAX_INFLIGHT_PER_USER = "1";
    const users = [USER_A, USER_B, USER_C, USER_D];
    const text = "The harbor was quiet after the rain.";
    const paths: string[] = [];
    const { uploadFile } = await import("@/lib/storage");
    const hash = createHash("sha256").update(text, "utf8").digest("hex");
    for (let i = 0; i < users.length; i++) {
      const uploadId = `4444444${i}-4444-4444-8444-444444444444`;
      paths.push(await seedUpload({ id: uploadId, userId: users[i]!, text }));
      await uploadFile(
        `pdfs/${uploadId}`,
        "listen-cleaned.txt",
        Buffer.from(text),
        "text/plain"
      );
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
    const userById = new Map<string, string>();
    for (let i = 0; i < 200; i++) {
      const id = `burst-${i}`;
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
    const fake = createFakeProvider();
    vi.spyOn(providers, "resolveStockAdapter").mockReturnValue(fake);
    const { listDrainableTakehomeJobs, processTakehomeTick } = await import(
      "@/lib/tts/process-job"
    );
    const running = new Map<string, Promise<void>>();
    const started: string[] = [];
    let maxActive = 0;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 180_000) {
      const counts = await query<{ status: string; n: number }>(
        `SELECT status, COUNT(*) AS n FROM jobs WHERE id LIKE 'burst-%' GROUP BY status`
      );
      const ready = Number(counts.find((row) => row.status === "ready")?.n || 0);
      const failed = Number(counts.find((row) => row.status === "failed")?.n || 0);
      if (ready + failed === 200 && running.size === 0) break;
      if (running.size < 2) {
        const listed = await listDrainableTakehomeJobs(8);
        for (const id of listed) {
          if (running.size >= 2 || running.has(id)) continue;
          started.push(userById.get(id) || "");
          const work = processTakehomeTick(id, {
            sectionsPerTick: 1,
            deadlineMs: Date.now() + 60_000,
          }).then(() => undefined);
          running.set(id, work);
          maxActive = Math.max(maxActive, running.size);
          void work.finally(() => running.delete(id));
        }
      }
      if (running.size === 0) {
        const again = await listDrainableTakehomeJobs(8);
        if (again.length === 0) break;
      }
      if (running.size > 0) await Promise.race(running.values());
    }
    const rows = await query<{ id: string; status: string; audio_storage_path: string | null }>(
      `SELECT id, status, audio_storage_path FROM jobs WHERE id LIKE 'burst-%'`
    );
    expect(rows.filter((row) => row.status === "failed")).toHaveLength(0);
    expect(rows.filter((row) => row.status === "ready")).toHaveLength(200);
    const pathsOut = new Set(rows.map((row) => row.audio_storage_path));
    expect(pathsOut.size).toBe(200);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(0);
    expect(new Set(started.slice(0, 8)).size).toBeGreaterThanOrEqual(3);
  }, 180_000);
});
