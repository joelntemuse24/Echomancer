/**
 * Bounded CPU smoke. Synthetic rows only.
 *
 * Proves the real app path: short generated tones, isolated cpu_tasks,
 * master, caller disconnect with a late completion, one in-flight POST,
 * no second publish, then concat. No speech provider and no GPU.
 *
 * Remote (the take-home VM stays on CPU_RUNNER unset; this process sets
 * modal for itself). Cold start is waited out, up to SMOKE_BOUND_MS.
 * The caller is killed when the container heartbeats, not after a sleep.
 *
 *   node --import tsx scripts/cpu/smoke-remote.ts --confirm-synthetic
 *
 * Requires MODAL_CPU_URL (host only), MODAL_CPU_TOKEN, Turso, and R2.
 * The token is sent as a bearer and is not printed.
 *
 * Local ffmpeg, temp database, no R2 (CI and a laptop):
 *
 *   node --import tsx scripts/cpu/smoke-remote.ts --local
 *
 * Delete one stranded synthetic run and nothing else:
 *
 *   node --import tsx scripts/cpu/smoke-remote.ts --confirm-synthetic \
 *     --cleanup-only cpusmoke<16 hex>
 *
 * Exit 0 when every check passed and cleanup removed only that run.
 * Exit 2 is usage. Exit 1 is a failed check; cleanup still runs.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertBareCpuEndpoint,
  assertDeletableSmokeKey,
  assertDispatchTaskId,
  assertSmokeRunId,
  smokeRunIdFromBytes,
  smokeStoragePrefix,
  smokeUserId,
} from "@/lib/cpu/smoke-id";

const scriptPath = fileURLToPath(new URL(import.meta.url));

type TaskSnap = {
  id: string;
  status: string;
  attempts: number;
  owner_token: string | null;
  lease_expires_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  placed_at: number | null;
  deadline_at: number | null;
  error_message: string | null;
};

type Finish = {
  final?: TaskSnap | null;
  disconnect?: string;
  singleflight?: string;
  call?: string;
  calls?: string[];
};

type Summary = Record<string, unknown>;

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) return "";
  return value;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function boundMs(): number {
  const raw = Number(process.env.SMOKE_BOUND_MS || "240000");
  if (!Number.isFinite(raw)) return 240_000;
  return Math.min(600_000, Math.max(30_000, Math.floor(raw)));
}

function toneWav(frequency: number): Buffer {
  const sampleRate = 16_000;
  const samples = Math.floor(sampleRate * 0.5);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.2;
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(value * 32767))), i * 2);
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

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function looksLikeMp3(body: Buffer): boolean {
  if (body.length < 128) return false;
  if (body.subarray(0, 3).toString("ascii") === "ID3") return true;
  const b1 = body[1];
  return body[0] === 0xff && b1 !== undefined && (b1 & 0xe0) === 0xe0;
}

function usage(): never {
  console.error(
    "usage: node --import tsx scripts/cpu/smoke-remote.ts --confirm-synthetic\n" +
      "       node --import tsx scripts/cpu/smoke-remote.ts --local\n" +
      "       node --import tsx scripts/cpu/smoke-remote.ts --confirm-synthetic --cleanup-only cpusmoke<16 hex>"
  );
  process.exit(2);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function snap(
  row: {
    id: string;
    status: string;
    attempts: number;
    owner_token: string | null;
    lease_expires_at: number | null;
    started_at?: number | null;
    finished_at?: number | null;
    placed_at?: number | null;
    deadline_at?: number | null;
    error_message: string | null;
  } | null
): TaskSnap | null {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    attempts: Number(row.attempts),
    owner_token: row.owner_token,
    lease_expires_at: row.lease_expires_at == null ? null : Number(row.lease_expires_at),
    started_at: row.started_at == null ? null : Number(row.started_at),
    finished_at: row.finished_at == null ? null : Number(row.finished_at),
    placed_at: row.placed_at == null ? null : Number(row.placed_at),
    deadline_at: row.deadline_at == null ? null : Number(row.deadline_at),
    error_message: row.error_message,
  };
}

async function main(): Promise<number> {
  const dispatch = argValue("--dispatch");
  if (dispatch !== null) {
    if (!dispatch) usage();
    assertDispatchTaskId(dispatch);
    const { runCpuTask } = await import("@/lib/cpu/runner");
    const result = await runCpuTask(dispatch);
    console.log(JSON.stringify({ event: "dispatch", taskId: dispatch, result }));
    return 0;
  }

  const local = hasFlag("--local");
  const confirm = hasFlag("--confirm-synthetic");
  const cleanupOnly = argValue("--cleanup-only");
  if (!local && !confirm) usage();
  if (cleanupOnly !== null && !cleanupOnly) usage();

  let tempDir: string | null = null;
  if (local) {
    if (cleanupOnly !== null) {
      console.error("--local does not take --cleanup-only");
      return 2;
    }
    tempDir = await mkdtemp(path.join(tmpdir(), "cpu-smoke-"));
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.STORAGE_PATH = path.join(tempDir, "storage");
    process.env.TURSO_DATABASE_URL = `file:${path.join(tempDir, "smoke.db")}`;
    process.env.TURSO_AUTH_TOKEN = "";
    process.env.CPU_RUNNER = "local";
    process.env.TTS_SECTION_QA_ENABLED = "0";
    let ffmpeg = "/usr/bin/ffmpeg";
    try {
      accessSync(ffmpeg, constants.X_OK);
    } catch {
      ffmpeg = "ffmpeg";
    }
    process.env.FFMPEG_PATH = ffmpeg;
    process.env.TTS_CONCAT_CROSSFADE_FFMPEG = "1";
    delete process.env.VITEST;
    for (const key of [
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET_NAME",
      "R2_PUBLIC_URL",
      "MODAL_CPU_URL",
      "MODAL_CPU_TOKEN",
    ]) {
      process.env[key] = "";
    }
  } else {
    const endpoint = process.env.MODAL_CPU_URL?.trim() || "";
    const token = process.env.MODAL_CPU_TOKEN?.trim() || process.env.WORKER_SECRET?.trim() || "";
    if (!process.env.TURSO_DATABASE_URL) {
      console.error("TURSO_DATABASE_URL is not set");
      return 2;
    }
    if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
      console.error("R2 credentials are not set");
      return 2;
    }
    if (cleanupOnly === null) {
      if (!endpoint) {
        console.error("MODAL_CPU_URL is not set");
        return 2;
      }
      if (!token) {
        console.error("MODAL_CPU_TOKEN is not set");
        return 2;
      }
      try {
        process.env.MODAL_CPU_URL = assertBareCpuEndpoint(endpoint);
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        return 2;
      }
      process.env.CPU_RUNNER = "modal";
      process.env.CPU_DISPATCH_ACCEPT_MS = "60000";
      process.env.CPU_PLACEMENT_LEASE_S = "600";
      process.env.TTS_SECTION_QA_ENABLED = "0";
    }
  }

  const summary: Summary = { event: "summary", ok: false, mode: local ? "local" : "remote" };
  let runId = "";
  try {
    if (cleanupOnly !== null) {
      runId = cleanupOnly;
      assertSmokeRunId(runId);
      summary.runId = runId;
      summary.cleanup = await removeRun(runId);
      summary.ok = true;
      console.log(JSON.stringify(summary));
      return 0;
    }

    runId = smokeRunIdFromBytes(randomBytes(8));
    summary.runId = runId;
    summary.boundMs = boundMs();
    const outcome = await runSmoke(runId, local);
    Object.assign(summary, outcome);
    summary.cleanup = await removeRun(runId);
    const cleanup = summary.cleanup as {
      ourJobLeft: number;
      ourTasksLeft: number;
      foreignJobsDropped: number;
      foreignTasksDropped: number;
      keysLeft: string[];
    };
    summary.ok =
      outcome.ok === true &&
      cleanup.ourJobLeft === 0 &&
      cleanup.ourTasksLeft === 0 &&
      cleanup.keysLeft.length === 0 &&
      cleanup.foreignJobsDropped === 0 &&
      cleanup.foreignTasksDropped === 0;
    console.log(JSON.stringify(summary));
    return summary.ok ? 0 : 1;
  } catch (err) {
    summary.error = err instanceof Error ? err.message : String(err);
    if (runId) {
      try {
        summary.cleanup = await removeRun(runId);
      } catch (cleanupErr) {
        summary.cleanupError = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      }
    }
    console.log(JSON.stringify(summary));
    return 1;
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}

async function countWhere(sql: string, args: string[]): Promise<number> {
  const { queryOne } = await import("@/lib/turso");
  const row = await queryOne<{ n: number }>(sql, args);
  return Number(row?.n || 0);
}

async function removeRun(runId: string): Promise<Record<string, unknown>> {
  assertSmokeRunId(runId);
  const userId = smokeUserId(runId);
  const prefix = smokeStoragePrefix(runId);
  const { ensureTtsJobColumns } = await import("@/lib/tts/schema-migrate");
  await ensureTtsJobColumns();
  const { execute } = await import("@/lib/turso");
  const { deleteFile, listFiles } = await import("@/lib/storage/index");
  const foreignJobsBefore = await countWhere(`SELECT COUNT(*) AS n FROM jobs WHERE id != ?`, [runId]);
  const foreignTasksBefore = await countWhere(
    `SELECT COUNT(*) AS n FROM cpu_tasks WHERE job_id IS NULL OR job_id != ?`,
    [runId]
  );
  const listed = await listFiles(`audiobooks/${runId}`);
  const keys = listed.filter((key) => key.startsWith(prefix));
  for (const key of keys) {
    assertDeletableSmokeKey(runId, key);
    await deleteFile(key);
  }
  await execute(
    `DELETE FROM cpu_tasks WHERE job_id = ? AND job_id LIKE 'cpusmoke%'`,
    [runId]
  );
  await execute(
    `DELETE FROM jobs WHERE id = ? AND user_id = ? AND id LIKE 'cpusmoke%' AND user_id LIKE 'cpusmoke%'`,
    [runId, userId]
  );
  const ourJobLeft = await countWhere(`SELECT COUNT(*) AS n FROM jobs WHERE id = ?`, [runId]);
  const ourTasksLeft = await countWhere(`SELECT COUNT(*) AS n FROM cpu_tasks WHERE job_id = ?`, [runId]);
  const foreignJobsAfter = await countWhere(`SELECT COUNT(*) AS n FROM jobs WHERE id != ?`, [runId]);
  const foreignTasksAfter = await countWhere(
    `SELECT COUNT(*) AS n FROM cpu_tasks WHERE job_id IS NULL OR job_id != ?`,
    [runId]
  );
  const left = (await listFiles(`audiobooks/${runId}`)).filter((key) => key.startsWith(prefix));
  return {
    deletedKeys: keys,
    keysLeft: left,
    ourJobLeft,
    ourTasksLeft,
    foreignJobsBefore,
    foreignJobsAfter,
    foreignJobsDropped: Math.max(0, foreignJobsBefore - foreignJobsAfter),
    foreignTasksBefore,
    foreignTasksAfter,
    foreignTasksDropped: Math.max(0, foreignTasksBefore - foreignTasksAfter),
  };
}

async function taskOf(id: string): Promise<TaskSnap | null> {
  const { getCpuTask } = await import("@/lib/cpu/tasks");
  return snap(await getCpuTask(id));
}

async function waitTerminal(id: string, started: number): Promise<TaskSnap> {
  const limit = boundMs();
  for (;;) {
    const row = await taskOf(id);
    if (!row) throw new Error(`${id} disappeared`);
    if (row.status === "done" || row.status === "failed" || row.status === "cancelled") return row;
    if (Date.now() - started > limit) {
      throw new Error(`${id} still ${row.status} after ${limit}ms ${JSON.stringify(row)}`);
    }
    await sleep(200);
  }
}

async function runSmoke(runId: string, local: boolean): Promise<Summary> {
  assertSmokeRunId(runId);
  const { ensureTtsJobColumns } = await import("@/lib/tts/schema-migrate");
  const { execute, queryOne } = await import("@/lib/turso");
  const { uploadFile, downloadFile } = await import("@/lib/storage/index");
  const { enqueueCpuTask, completeCpuTask } = await import("@/lib/cpu/tasks");
  const { runCpuTask } = await import("@/lib/cpu/runner");
  await ensureTtsJobColumns();

  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM jobs WHERE id = ? OR user_id = ?`,
    [runId, runId]
  );
  if (existing) throw new Error(`smoke id already present: ${existing.id}`);

  const prefix = smokeStoragePrefix(runId);
  const userId = smokeUserId(runId);
  await uploadFile(`audiobooks/${runId}`, "source.txt", Buffer.from("cpu smoke\n"), "text/plain");
  await execute(
    `INSERT INTO jobs (
       id, user_id, book_title, pdf_storage_path, status, job_kind, total_sections, generation_mode
     ) VALUES (?, ?, 'CPU smoke', ?, 'ready', 'takehome', 2, 'stock')`,
    [runId, userId, `${prefix}source.txt`]
  );

  const checks: Record<string, unknown> = {};
  const master0 = await putMaster(runId, 0, 440, uploadFile, enqueueCpuTask);
  const first = await finishTask(master0, runCpuTask, local, null);
  const out0 = await downloadFile(`${prefix}sections/0000.mp3`);
  const raw0 = await downloadFile(`${prefix}raw/0000.wav`);
  checks.master0 = {
    ...first,
    outputBytes: out0.length,
    mp3: looksLikeMp3(out0),
    differsFromRaw: !out0.equals(raw0),
  };

  let disconnectId = await putMaster(runId, 1, 880, uploadFile, enqueueCpuTask);
  let second = await finishTask(disconnectId, runCpuTask, local, local ? null : scriptPath);
  if (!local && second.disconnect !== "killed-while-claimed") {
    disconnectId = await putMaster(runId, 2, 660, uploadFile, enqueueCpuTask);
    second = await finishTask(disconnectId, runCpuTask, local, scriptPath);
    checks.disconnectRetry = true;
  }
  const disconnectIndex = Number(disconnectId.split(":").pop());
  const disconnectPath = `${prefix}sections/${String(disconnectIndex).padStart(4, "0")}.mp3`;
  const disconnected = await downloadFile(disconnectPath);
  const hash1 = sha256(disconnected);
  const again = await runCpuTask(disconnectId);
  const hash2 = sha256(await downloadFile(disconnectPath));
  const after = await taskOf(disconnectId);
  const fenced = await completeCpuTask(disconnectId, "ab".repeat(16));
  const section1 = await downloadFile(`${prefix}sections/0001.mp3`);
  checks.master1 = {
    taskId: disconnectId,
    ...second,
    republishResult: again,
    republishUnchanged: hash1 === hash2,
    attemptsAfterRepublish: after?.attempts ?? null,
    wrongOwnerCompleted: fenced,
    outputBytes: disconnected.length,
    mp3: looksLikeMp3(disconnected),
  };

  const segments = [0, 1].map((index) => ({
    index,
    path: `${prefix}sections/${String(index).padStart(4, "0")}.mp3`,
    status: "ready",
    mastered: true,
    contentType: "audio/mpeg",
  }));
  await execute(
    `UPDATE jobs SET segments_json = ?, total_sections = 2, status = 'ready', updated_at = unixepoch()
     WHERE id = ? AND user_id = ?`,
    [JSON.stringify(segments), runId, userId]
  );
  const concatId = `concat:${runId}`;
  await enqueueCpuTask({
    id: concatId,
    kind: "concat",
    jobId: runId,
    outputPath: `${prefix}full.mp3`,
    inputPath: `audiobooks/${runId}`,
  });
  const joined = await finishTask(concatId, runCpuTask, local, null);
  const full = await downloadFile(`${prefix}full.mp3`);
  const job = await queryOne<{ status: string; deleted_at: number | null }>(
    `SELECT status, deleted_at FROM jobs WHERE id = ?`,
    [runId]
  );
  checks.concat = {
    ...joined,
    outputBytes: full.length,
    mp3: looksLikeMp3(full),
    longerThanEachSection: full.length > out0.length && full.length > section1.length,
    jobStatus: job?.status ?? null,
    jobDeleted: job?.deleted_at != null,
  };

  const masterOk =
    first.final?.status === "done" &&
    looksLikeMp3(out0) &&
    !out0.equals(raw0);
  const republishOk =
    again === "done" &&
    hash1 === hash2 &&
    after?.attempts === second.final?.attempts &&
    fenced === false;
  const disconnectOk = local
    ? true
    : second.disconnect === "killed-while-claimed" && second.final?.status === "done";
  const singleOk = local
    ? (second.singleflight === "one-claim" || second.singleflight === "accepted-while-claimed") &&
      second.final?.attempts === 1
    : second.singleflight === "accepted-while-claimed" && second.final?.attempts === 1;
  const concatOk =
    joined.final?.status === "done" &&
    looksLikeMp3(full) &&
    full.length > out0.length &&
    full.length > section1.length &&
    job?.status === "ready" &&
    job.deleted_at == null;

  return {
    ok: masterOk && republishOk && disconnectOk && singleOk && concatOk,
    checks,
    masterOk,
    republishOk,
    disconnectOk,
    singleOk,
    concatOk,
  };
}

async function putMaster(
  runId: string,
  index: number,
  frequency: number,
  uploadFile: (
    directory: string,
    filename: string,
    data: Buffer,
    contentType?: string
  ) => Promise<{ path: string; size: number }>,
  enqueueCpuTask: (input: {
    id: string;
    kind: "master";
    jobId: string;
    sectionIndex: number;
    inputPath: string;
    outputPath: string;
    payload: { extension: string; chain: string };
  }) => Promise<void>
): Promise<string> {
  const name = `${String(index).padStart(4, "0")}.wav`;
  const uploaded = await uploadFile(
    `audiobooks/${runId}/raw`,
    name,
    toneWav(frequency),
    "audio/wav"
  );
  const id = `master:${runId}:${index}`;
  await enqueueCpuTask({
    id,
    kind: "master",
    jobId: runId,
    sectionIndex: index,
    inputPath: uploaded.path,
    outputPath: `audiobooks/${runId}/sections/${String(index).padStart(4, "0")}.mp3`,
    payload: { extension: "wav", chain: "podcast" },
  });
  return id;
}

async function finishTask(
  taskId: string,
  runCpuTask: (id: string) => Promise<string>,
  local: boolean,
  disconnectScript: string | null
): Promise<Finish & Record<string, unknown>> {
  const started = Date.now();
  if (disconnectScript && !local) {
    return disconnectRemote(taskId, disconnectScript, runCpuTask, started);
  }
  if (local && taskId.endsWith(":1")) {
    const { runCpuTask: run } = await import("@/lib/cpu/runner");
    const [a, b] = await Promise.all([run(taskId), run(taskId)]);
    const row = await waitTerminal(taskId, started);
    return {
      calls: [a, b],
      singleflight: row.attempts === 1 ? "one-claim" : "overlap",
      disconnect: "not-applicable",
      final: row,
      elapsedMs: Date.now() - started,
    };
  }
  const result = await runCpuTask(taskId);
  let row = await taskOf(taskId);
  if (result === "failed" || result === "cancelled" || result === "deferred" || result === "lost") {
    return { call: result, disconnect: local ? "not-applicable" : "not-this-task", final: row, elapsedMs: Date.now() - started };
  }
  if (row?.status !== "done") row = await waitTerminal(taskId, started);
  return {
    call: result,
    disconnect: local ? "not-applicable" : "waited",
    singleflight: "single-call",
    final: row,
    elapsedMs: Date.now() - started,
  };
}

async function disconnectRemote(
  taskId: string,
  script: string,
  runCpuTask: (id: string) => Promise<string>,
  started: number
): Promise<Finish & Record<string, unknown>> {
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", script, "--dispatch", taskId],
    { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] }
  );
  let childOut = "";
  child.stdout?.on("data", (chunk) => {
    childOut += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    childOut += chunk.toString();
  });
  let killedAt: number | null = null;
  let overlap: string | null = null;
  let ownerAtKill: string | null = null;
  let attemptsAtKill: number | null = null;
  try {
    for (;;) {
      const row = await taskOf(taskId);
      if (!row) throw new Error(`${taskId} disappeared before disconnect`);
      if (row.started_at != null && row.status === "claimed") {
        ownerAtKill = row.owner_token;
        attemptsAtKill = row.attempts;
        overlap = await runCpuTask(taskId);
        const mid = await taskOf(taskId);
        child.kill("SIGKILL");
        killedAt = Date.now();
        const sameOwner = mid?.owner_token === ownerAtKill && mid?.status === "claimed";
        return {
          disconnect: "killed-while-claimed",
          killedAfterMs: killedAt - started,
          ownerAtKill,
          attemptsAtKill,
          singleflight:
            overlap === "accepted" && (sameOwner || mid?.status === "done")
              ? "accepted-while-claimed"
              : overlap,
          overlapStatus: mid?.status ?? null,
          childOut: childOut.slice(-500),
          final: await waitTerminal(taskId, started),
          elapsedMs: Date.now() - started,
        };
      }
      if (row.status === "done" || row.status === "failed" || row.status === "cancelled") {
        return {
          disconnect: "finished-before-kill",
          singleflight: "missed",
          childOut: childOut.slice(-500),
          final: row,
          elapsedMs: Date.now() - started,
        };
      }
      if (Date.now() - started > boundMs()) {
        throw new Error(`${taskId} never heartbeated ${JSON.stringify(row)} ${childOut.slice(-500)}`);
      }
      await sleep(15);
    }
  } finally {
    if (killedAt == null) child.kill("SIGKILL");
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
