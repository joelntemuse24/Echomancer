/**
 * Cloudflare Worker: document extract next to R2.
 *
 * Fallback host when the always-on Node worker is unreachable. The Free
 * plan CPU limit kills a real PDF before this process can write a failed
 * status, so Vercel sends every document to the Node worker first and
 * only POSTs here when that call fails. The parse is `runUploadExtract`,
 * the same function the Node worker runs.
 *
 * POST { uploadId }  Authorization: Bearer EXTRACT_WORKER_SECRET
 * Returns 202 immediately; extract continues via waitUntil.
 */

import { createClient, type Client } from "@libsql/client/web";
import { AwsClient } from "aws4fetch";
import {
  FAIL_WAITING_TAKEHOMES_SQL,
  QUEUE_WAITING_TAKEHOMES_SQL,
  waitingReleaseForUpload,
} from "../../../src/lib/jobs/waiting-takehome-sql";
import { runUploadExtract } from "../../../src/lib/uploads/run-extract";
import type { ExtractSnapshot } from "../../../src/lib/uploads/run-extract";

export interface ExtractEnv {
  BOOKS?: R2Bucket;
  EXTRACT_WORKER_SECRET?: string;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
}

type UploadRow = {
  id: string;
  source_path: string | null;
  file_name: string | null;
  content_type: string | null;
  status: string | null;
  error_message: string | null;
  extract_host: string | null;
};

function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

function turso(env: ExtractEnv): Client {
  const url = env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL is not defined");
  return createClient({
    url,
    authToken: env.TURSO_AUTH_TOKEN,
  });
}

async function getUpload(db: Client, id: string): Promise<UploadRow | null> {
  const result = await db.execute({
    sql: "SELECT id, source_path, file_name, content_type, status, error_message, extract_host FROM uploads WHERE id = ? LIMIT 1",
    args: [id],
  });
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    source_path: row.source_path == null ? null : String(row.source_path),
    file_name: row.file_name == null ? null : String(row.file_name),
    content_type: row.content_type == null ? null : String(row.content_type),
    status: row.status == null ? null : String(row.status),
    error_message:
      row.error_message == null ? null : String(row.error_message),
    extract_host: row.extract_host == null ? null : String(row.extract_host),
  };
}

function snapshot(row: UploadRow): ExtractSnapshot {
  return {
    status: row.status,
    sourcePath: row.source_path,
    fileName: row.file_name,
    contentType: row.content_type,
    errorMessage: row.error_message,
    extractHost: row.extract_host,
  };
}

async function getObject(
  env: ExtractEnv,
  key: string
): Promise<Uint8Array | null> {
  if (env.BOOKS) {
    const obj = await env.BOOKS.get(key);
    if (!obj) return null;
    return new Uint8Array(await obj.arrayBuffer());
  }
  const account = env.R2_ACCOUNT_ID;
  const access = env.R2_ACCESS_KEY_ID;
  const secret = env.R2_SECRET_ACCESS_KEY;
  const bucket = env.R2_BUCKET_NAME || "echomancer-audio";
  if (!account || !access || !secret) {
    throw new Error("R2 binding or S3 credentials missing");
  }
  const aws = new AwsClient({
    accessKeyId: access,
    secretAccessKey: secret,
    service: "s3",
    region: "auto",
  });
  const url = `https://${account}.r2.cloudflarestorage.com/${bucket}/${key}`;
  const res = await aws.fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`R2 GET ${key} failed (${res.status})`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function putObject(
  env: ExtractEnv,
  key: string,
  body: Uint8Array,
  contentType: string
): Promise<void> {
  if (env.BOOKS) {
    await env.BOOKS.put(key, body, { httpMetadata: { contentType } });
    return;
  }
  const account = env.R2_ACCOUNT_ID;
  const access = env.R2_ACCESS_KEY_ID;
  const secret = env.R2_SECRET_ACCESS_KEY;
  const bucket = env.R2_BUCKET_NAME || "echomancer-audio";
  if (!account || !access || !secret) {
    throw new Error("R2 binding or S3 credentials missing");
  }
  const aws = new AwsClient({
    accessKeyId: access,
    secretAccessKey: secret,
    service: "s3",
    region: "auto",
  });
  const url = `https://${account}.r2.cloudflarestorage.com/${bucket}/${key}`;
  const res = await aws.fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body,
  });
  if (!res.ok) {
    throw new Error(`R2 PUT ${key} failed (${res.status})`);
  }
}

async function releaseWaitingTakehomes(
  db: Client,
  uploadId: string
): Promise<void> {
  const result = await db.execute({
    sql: `SELECT storage_path, status, error_message FROM uploads WHERE id = ? LIMIT 1`,
    args: [uploadId],
  });
  const row = result.rows[0];
  if (!row) return;
  const storagePath = row.storage_path == null ? "" : String(row.storage_path);
  if (!storagePath) return;
  const decision = waitingReleaseForUpload(
    row.status == null ? null : String(row.status),
    row.error_message == null ? null : String(row.error_message)
  );
  if (decision.action === "queue") {
    await db.execute({ sql: QUEUE_WAITING_TAKEHOMES_SQL, args: [storagePath] });
    return;
  }
  if (decision.action === "fail") {
    await db.execute({
      sql: FAIL_WAITING_TAKEHOMES_SQL,
      args: [decision.message, storagePath],
    });
  }
}

async function runExtract(env: ExtractEnv, uploadId: string): Promise<void> {
  const db = turso(env);
  try {
    await runExtractBody(db, env, uploadId);
  } finally {
    await releaseWaitingTakehomes(db, uploadId).catch((err) => {
      console.error(
        `[extract] waiting take-homes stayed parked for ${uploadId}`,
        err
      );
    });
  }
}

async function runExtractBody(
  db: Client,
  env: ExtractEnv,
  uploadId: string
): Promise<void> {
  const result = await runUploadExtract(uploadId, "cloudflare", {
    async load(id) {
      const row = await getUpload(db, id);
      return row ? snapshot(row) : null;
    },
    async claim(id) {
      // Do not take a row the Node worker already owns.
      const claimed = await db.execute({
        sql: `UPDATE uploads
              SET status = 'extracting',
                  extract_started_at = unixepoch(),
                  error_message = NULL,
                  extract_host = 'cloudflare',
                  extract_attempts = COALESCE(extract_attempts, 0) + 1,
                  extract_accepted_at = COALESCE(extract_accepted_at, unixepoch())
              WHERE id = ?
                AND status IN ('uploaded', 'extracting')
                AND (extract_host IS NULL OR extract_host = 'cloudflare')`,
        args: [id],
      });
      return claimed.rowsAffected > 0;
    },
    async fail(id, host, message) {
      await db.execute({
        sql: `UPDATE uploads
              SET status = 'failed', error_message = ?
              WHERE id = ? AND status != 'ready'
                AND (extract_host IS NULL OR extract_host = ?)`,
        args: [message, id, host],
      });
    },
    async finish(id, host, charCount) {
      await db.execute({
        sql: `UPDATE uploads
              SET status = 'ready', char_count = ?, error_message = NULL, extract_started_at = NULL
              WHERE id = ? AND status = 'extracting'
                AND (extract_host IS NULL OR extract_host = ?)`,
        args: [charCount, id, host],
      });
    },
    async readSource(path) {
      return getObject(env, path);
    },
    async writeObject(key, bytes, contentType) {
      await putObject(env, key, bytes, contentType);
    },
  });
  if (result.outcome === "pending") {
    throw new Error("The document has not finished uploading yet.");
  }
  if (result.outcome === "missing") {
    throw new Error("Upload not found");
  }
}

export default {
  async fetch(request: Request, env: ExtractEnv, ctx: ExecutionContext) {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    const secret = env.EXTRACT_WORKER_SECRET;
    const auth = request.headers.get("authorization") || "";
    if (!secret || auth !== `Bearer ${secret}`) {
      return unauthorized();
    }
    let uploadId = "";
    try {
      const body = (await request.json()) as { uploadId?: string };
      uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
    } catch {
      return Response.json({ error: "Expected JSON { uploadId }" }, { status: 400 });
    }
    if (!uploadId) {
      return Response.json({ error: "uploadId required" }, { status: 400 });
    }

    ctx.waitUntil(
      runExtract(env, uploadId).catch((err) => {
        console.error(`[extract] Worker failed for ${uploadId}`, err);
      })
    );
    return Response.json({ uploadId, status: "extracting" }, { status: 202 });
  },
};
