/**
 * HTTP surface for the always-on take-home worker.
 * Kept separate from Node's `http` server so route tests need no socket.
 */

import { authorizeWorkerRequest } from "@/worker/auth";
import type { TakehomeWorkerLoop } from "@/worker/takehome-loop";

export interface WorkerHttpResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface RouteTakehomeWorkerInput {
  method: string;
  url: string;
  authorization?: string;
  workerSecret?: string;
  internalSecret?: string;
  bodyText?: string;
  loop: TakehomeWorkerLoop;
  startedAt: number;
  ready?: () => Promise<boolean>;
  acceptJob?: (
    jobId: string
  ) => Promise<"ok" | "missing" | "wrong-kind">;
  startListenPrep?: (uploadId: string) => void;
  wakeClip?: () => void;
  checkReference?: (input: { uploadId: string; samplePath: string; remasterFailing: boolean }) => Promise<unknown>;
}

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): WorkerHttpResult {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
    body,
  };
}

function pathname(url: string): string {
  try {
    return new URL(url, "http://worker.local").pathname;
  } catch {
    return url.split("?")[0] || "/";
  }
}

function parseJobId(bodyText: string | undefined): string | null {
  if (!bodyText?.trim()) return null;
  try {
    const parsed = JSON.parse(bodyText) as { jobId?: unknown; job_id?: unknown };
    const raw = parsed.jobId ?? parsed.job_id;
    return typeof raw === "string" && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
}

export async function routeTakehomeWorkerRequest(
  input: RouteTakehomeWorkerInput
): Promise<WorkerHttpResult> {
  const path = pathname(input.url);
  const method = input.method.toUpperCase();

  if (method === "GET" && (path === "/health" || path === "/")) {
    return json(200, {
      ok: true,
      service: "echomancer-takehome",
      inflight: input.loop.inflightCount,
      concurrency: input.loop.concurrency,
      uptimeSec: Math.floor((Date.now() - input.startedAt) / 1000),
      clipProvider: process.env.APIFY_TOKEN?.trim() ? "apify" : null,
    });
  }

  if (method === "GET" && path === "/ready") {
    const ready = input.ready ? await input.ready() : true;
    return json(ready ? 200 : 503, {
      ok: ready,
      service: "echomancer-takehome",
      inflight: input.loop.inflightCount,
    });
  }

  if (method === "POST" && path === "/jobs") {
    if (
      !authorizeWorkerRequest({
        authorization: input.authorization,
        workerSecret: input.workerSecret,
        internalSecret: input.internalSecret,
      })
    ) {
      return json(401, { ok: false, error: "Unauthorized" });
    }
    const jobId = parseJobId(input.bodyText);
    if (!jobId) {
      return json(400, { ok: false, error: "jobId is required" });
    }
    if (input.acceptJob) {
      const accept = await input.acceptJob(jobId);
      if (accept === "missing" || accept === "wrong-kind") {
        return json(404, { ok: false, error: "Job not found" });
      }
    }
    const started = input.loop.enqueue(jobId);
    if (!started) {
      // Full slot table or already running — Turso still has the queued row.
      void input.loop.drain();
    }
    return json(202, {
      ok: true,
      accepted: true,
      jobId,
      started,
      inflight: input.loop.inflightCount,
    });
  }

  if (method === "POST" && path === "/listen-prep") {
    if (
      !authorizeWorkerRequest({
        authorization: input.authorization,
        workerSecret: input.workerSecret,
        internalSecret: input.internalSecret,
      })
    ) {
      return json(401, { ok: false, error: "Unauthorized" });
    }
    const uploadId = parseUploadId(input.bodyText);
    if (!uploadId) {
      return json(400, { ok: false, error: "uploadId is required" });
    }
    input.startListenPrep?.(uploadId);
    return json(202, { ok: true, accepted: true, uploadId });
  }

  if (method === "POST" && path === "/clips/wake") {
    if (
      !authorizeWorkerRequest({
        authorization: input.authorization,
        workerSecret: input.workerSecret,
        internalSecret: input.internalSecret,
      })
    ) {
      return json(401, { ok: false, error: "Unauthorized" });
    }
    input.wakeClip?.();
    return json(202, { ok: true });
  }

  if (method === "POST" && path === "/reference-quality") {
    if (
      !authorizeWorkerRequest({
        authorization: input.authorization,
        workerSecret: input.workerSecret,
        internalSecret: input.internalSecret,
      })
    ) {
      return json(401, { ok: false, error: "Unauthorized" });
    }
    const ref = parseReferenceInput(input.bodyText);
    if (!ref) {
      return json(400, { ok: false, error: "uploadId and samplePath are required" });
    }
    if (!input.checkReference) return json(503, { ok: false, error: "Not available" });
    const result = await input.checkReference(ref);
    return json(200, { ok: true, result: result ?? null });
  }

  return json(404, { ok: false, error: "Not found" });
}

function parseReferenceInput(
  bodyText: string | undefined
): { uploadId: string; samplePath: string; remasterFailing: boolean } | null {
  if (!bodyText?.trim()) return null;
  try {
    const parsed = JSON.parse(bodyText) as {
      uploadId?: unknown;
      samplePath?: unknown;
      remasterFailing?: unknown;
    };
    const uploadId = typeof parsed.uploadId === "string" ? parsed.uploadId.trim() : "";
    const samplePath = typeof parsed.samplePath === "string" ? parsed.samplePath.trim() : "";
    if (!uploadId || uploadId.length > 80 || !/^[\w-]+$/.test(uploadId)) return null;
    if (!samplePath || samplePath.length > 400) return null;
    return { uploadId, samplePath, remasterFailing: parsed.remasterFailing === true };
  } catch {
    return null;
  }
}

function parseUploadId(bodyText: string | undefined): string | null {
  if (!bodyText?.trim()) return null;
  try {
    const parsed = JSON.parse(bodyText) as { uploadId?: unknown };
    const raw = parsed.uploadId;
    return typeof raw === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)
      ? raw
      : null;
  } catch {
    return null;
  }
}
