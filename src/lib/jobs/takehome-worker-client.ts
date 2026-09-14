/**
 * HTTP client from Vercel → always-on Whole-book VM worker.
 * Extract stays on Cloudflare Workers; this path is take-home only.
 */

import { AppError } from "@/lib/errors";

const DEFAULT_ATTEMPTS = 3;
const BACKOFF_MS = 250;

export function takehomeWorkerUrl(): string | undefined {
  const raw = (
    process.env.WORKER_URL ||
    process.env.TAKEHOME_WORKER_URL ||
    ""
  ).trim();
  return raw ? raw.replace(/\/$/, "") : undefined;
}

export function takehomeWorkerSecret(): string | undefined {
  return (
    process.env.WORKER_SECRET?.trim() ||
    process.env.TAKEHOME_WORKER_SECRET?.trim() ||
    process.env.INTERNAL_JOB_SECRET?.trim() ||
    undefined
  );
}

export function isTakehomeWorkerConfigured(): boolean {
  return Boolean(takehomeWorkerUrl() && takehomeWorkerSecret());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface EnqueueTakehomeOnWorkerOptions {
  attempts?: number;
}

/**
 * POST `{ jobId }` to the VM worker. 2xx / 202 is success; the job row
 * already exists in Turso so a later drain can pick it up if this fails.
 */
export async function enqueueTakehomeOnWorker(
  jobId: string,
  options: EnqueueTakehomeOnWorkerOptions = {}
): Promise<{ id: string }> {
  const url = takehomeWorkerUrl();
  const secret = takehomeWorkerSecret();
  if (!url || !secret) {
    throw new AppError(
      "TAKEHOME_WORKER_NOT_CONFIGURED",
      "Whole book generation is not configured (WORKER_URL is missing).",
      503
    );
  }

  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await postJob(url, secret, jobId);
    } catch (err) {
      lastError = err;
      if (attempt < attempts - 1) {
        await sleep(BACKOFF_MS * (attempt + 1));
      }
    }
  }

  const detail =
    lastError instanceof Error
      ? lastError.message
      : String(lastError ?? "unknown");
  console.error(
    `[takehome] VM worker dispatch failed after ${attempts} attempt(s)`,
    detail
  );
  throw new AppError(
    "TAKEHOME_WORKER_FAILED",
    `Could not enqueue take-home job on the VM worker.`,
    503
  );
}

async function postJob(
  url: string,
  secret: string,
  jobId: string
): Promise<{ id: string }> {
  const res = await fetch(`${url}/jobs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jobId }),
  });

  const text = await res.text().catch(() => "");
  if (res.status < 200 || res.status > 202) {
    throw new Error(
      `VM worker HTTP ${res.status}: ${text.slice(0, 240) || res.statusText}`
    );
  }
  return { id: jobId };
}
