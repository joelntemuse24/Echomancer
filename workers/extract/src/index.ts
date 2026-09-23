/**
 * Cloudflare Worker: document extract next to R2.
 *
 * Why this host and not Trigger: extract is CPU-light text parsing
 * (unpdf / mammoth / JSZip). Trigger's queue + machine cold start is for
 * Whole-book TTS (Fish, ffmpeg, DeepFilterNet). Workers start in
 * milliseconds and can bind the existing R2 bucket.
 *
 * POST { uploadId }  Authorization: Bearer EXTRACT_WORKER_SECRET
 * Returns 202 immediately; extract continues via waitUntil.
 */

import { createClient, type Client } from "@libsql/client/web";
import { AwsClient } from "aws4fetch";
import {
  CHAPTERS_JSON_NAME,
  emptyChapters,
  safeResolveChapters,
} from "../../../src/lib/book-chapters";
import { extractDocument, MIN_EXTRACTED_CHARS } from "../../../src/lib/text-extraction";
import { toSpeakableText } from "../../../src/lib/tts/speakable-text";

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
    sql: "SELECT id, source_path, file_name, content_type, status, error_message FROM uploads WHERE id = ? LIMIT 1",
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

async function runExtract(env: ExtractEnv, uploadId: string): Promise<void> {
  const db = turso(env);
  const row = await getUpload(db, uploadId);
  if (!row) throw new Error("Upload not found");
  if (row.status === "ready") return;
  if (row.status === "pending") {
    throw new Error("The document has not finished uploading yet.");
  }
  if (row.status === "failed" && row.error_message) return;

  await db.execute({
    sql: `UPDATE uploads
          SET status = 'extracting', extract_started_at = unixepoch(), error_message = NULL
          WHERE id = ? AND status IN ('uploaded', 'extracting')`,
    args: [uploadId],
  });

  const sourcePath = row.source_path;
  if (!sourcePath) {
    await db.execute({
      sql: `UPDATE uploads SET status = 'failed', error_message = ? WHERE id = ? AND status != 'ready'`,
      args: ["Upload is missing its source file.", uploadId],
    });
    return;
  }

  const bytes = await getObject(env, sourcePath);
  if (!bytes?.length) {
    throw new Error(`Failed to download ${sourcePath}`);
  }

  let extractedText: string;
  let chapters = emptyChapters();
  try {
    const extracted = await extractDocument(
      bytes,
      row.file_name || sourcePath,
      row.content_type || undefined
    );
    extractedText = toSpeakableText(extracted.text, {
      normalizeTitles: false,
    });
    chapters = safeResolveChapters(extractedText, extracted.hint);
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Could not read text from this document.";
    await db.execute({
      sql: `UPDATE uploads SET status = 'failed', error_message = ? WHERE id = ? AND status != 'ready'`,
      args: [message, uploadId],
    });
    return;
  }

  if (extractedText.length < MIN_EXTRACTED_CHARS) {
    await db.execute({
      sql: `UPDATE uploads SET status = 'failed', error_message = ? WHERE id = ? AND status != 'ready'`,
      args: [
        "Could not extract enough text from this document. It may be scanned, image-based, or DRM-protected.",
        uploadId,
      ],
    });
    return;
  }

  const encoder = new TextEncoder();
  const latest = await getUpload(db, uploadId);
  if (latest?.status === "ready") return;

  await putObject(
    env,
    `pdfs/${uploadId}/content.txt`,
    encoder.encode(extractedText),
    "text/plain; charset=utf-8"
  );

  try {
    await putObject(
      env,
      `pdfs/${uploadId}/${CHAPTERS_JSON_NAME}`,
      encoder.encode(JSON.stringify(chapters)),
      "application/json"
    );
  } catch (err) {
    console.error(`[extract] chapters.json failed for ${uploadId}`, err);
  }

  await db.execute({
    sql: `UPDATE uploads
          SET status = 'ready', char_count = ?, error_message = NULL, extract_started_at = NULL
          WHERE id = ? AND status = 'extracting'`,
    args: [extractedText.length, uploadId],
  });
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
