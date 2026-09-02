/**
 * Shared helpers for route-level tests.
 *
 * The point of this harness is that almost nothing is mocked: requests go
 * through the real handlers, against a real (in-memory) database and a real
 * filesystem-backed storage layer. Only the speech provider is a stand-in,
 * because that is the one dependency that costs money and needs the network.
 */

import { NextRequest } from "next/server";
import { closeTursoClient, execute } from "@/lib/turso";
import {
  ensureTtsJobColumns,
  resetSchemaMigrationCache,
} from "@/lib/tts/schema-migrate";
import { resetRateLimitTableCache } from "@/lib/rate-limit";
import { SESSION_COOKIE, signSessionToken } from "@/lib/auth/session";
import type {
  SynthesizeInput,
  SynthesizeResult,
  TtsProviderAdapter,
} from "@/lib/tts/types";

export const USER_A = "anon_" + "a".repeat(32);
export const USER_B = "anon_" + "b".repeat(32);

/**
 * Fresh database per test. `:memory:` is scoped to the client, so dropping the
 * singleton is enough to guarantee isolation.
 */
export async function resetDatabase(): Promise<void> {
  await closeTursoClient().catch(() => {});
  resetSchemaMigrationCache();
  resetRateLimitTableCache();
  await ensureTtsJobColumns();
}

export async function sessionCookieFor(userId: string): Promise<string> {
  return `${SESSION_COOKIE}=${await signSessionToken(userId)}`;
}

export interface RequestOptions {
  userId?: string | null;
  /** Raw `Cookie` header; wins over `userId` when both are set. */
  cookie?: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  formData?: FormData;
  rawBody?: BodyInit;
}

export async function buildRequest(
  url: string,
  options: RequestOptions = {}
): Promise<NextRequest> {
  const headers = new Headers(options.headers);
  if (options.cookie) {
    headers.set("cookie", options.cookie);
  } else if (options.userId) {
    headers.set("cookie", await sessionCookieFor(options.userId));
  }

  let body: BodyInit | undefined;
  if (options.formData) {
    body = options.formData;
  } else if (options.rawBody !== undefined) {
    body = options.rawBody;
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
  }

  return new NextRequest(new URL(url, "http://localhost").toString(), {
    method: options.method ?? (body ? "POST" : "GET"),
    headers,
    body,
  });
}

export function routeParams<T extends Record<string, string>>(
  params: T
): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

/** Minimal MP3-shaped bytes that pass the audible-audio guard. */
export function fakeMp3(sizeBytes = 2048, seed = 1): Buffer {
  const buf = Buffer.alloc(sizeBytes);
  buf[0] = 0xff;
  buf[1] = 0xfb;
  for (let i = 2; i < sizeBytes; i++) buf[i] = (i * seed) % 251 || 7;
  return buf;
}

/** A 44-byte WAV header declaring zero samples: the classic silent response. */
export function emptyWav(): Buffer {
  const buf = Buffer.alloc(44);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(24_000, 24);
  buf.writeUInt32LE(48_000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(0, 40);
  return buf;
}

export interface FakeProvider extends TtsProviderAdapter {
  calls: SynthesizeInput[];
}

/**
 * Stand-in speech provider. `respond` decides what each call returns, so a test
 * can make the third section fail, return silence, or hang.
 */
export function createFakeProvider(
  respond: (
    input: SynthesizeInput,
    callIndex: number
  ) => Promise<SynthesizeResult> | SynthesizeResult = () => ({
    audio: fakeMp3(),
    contentType: "audio/mpeg",
  })
): FakeProvider {
  const calls: SynthesizeInput[] = [];
  return {
    id: "openrouter",
    calls,
    streamContentType: "audio/mpeg",
    async synthesize(input) {
      const index = calls.length;
      calls.push(input);
      return respond(input, index);
    },
    async *synthesizeStream(input) {
      const index = calls.length;
      calls.push(input);
      const result = await respond(input, index);
      yield new Uint8Array(result.audio);
    },
  };
}

/** Insert an upload ownership row without running the upload route. */
export async function seedUpload(opts: {
  id: string;
  userId: string;
  text: string;
}): Promise<string> {
  const { uploadFile } = await import("@/lib/storage");
  const storagePath = `pdfs/${opts.id}/content.txt`;
  await uploadFile(
    `pdfs/${opts.id}`,
    "content.txt",
    Buffer.from(opts.text, "utf-8"),
    "text/plain"
  );
  await execute(
    `INSERT INTO uploads (id, user_id, storage_path, source_path, file_name, format, byte_size, char_count, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready')`,
    [
      opts.id,
      opts.userId,
      storagePath,
      `pdfs/${opts.id}/source.txt`,
      "book.txt",
      "txt",
      opts.text.length,
      opts.text.length,
    ]
  );
  return storagePath;
}

function cookieFromResponse(response: {
  cookies: { get: (name: string) => { value: string } | undefined };
}): string | undefined {
  const value = response.cookies.get(SESSION_COOKIE)?.value;
  return value ? `${SESSION_COOKIE}=${value}` : undefined;
}

export type UploadApiBody = {
  storagePath: string;
  charCount?: number;
  status?: string;
  error?: string;
  code?: string;
  fileName?: string;
  uploadId?: string;
};

function asUploadApiBody(raw: unknown): UploadApiBody {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    storagePath: typeof o.storagePath === "string" ? o.storagePath : "",
    charCount: typeof o.charCount === "number" ? o.charCount : undefined,
    status: typeof o.status === "string" ? o.status : undefined,
    error: typeof o.error === "string" ? o.error : undefined,
    code: typeof o.code === "string" ? o.code : undefined,
    fileName: typeof o.fileName === "string" ? o.fileName : undefined,
    uploadId: typeof o.uploadId === "string" ? o.uploadId : undefined,
  };
}

/**
 * Full document intake: JSON presign → PUT bytes → complete → extract.
 * Extraction reads from storage, never from the Vercel JSON body.
 */
export async function uploadBookViaApi(
  text: string,
  opts: { userId?: string | null; fileName?: string } = { userId: USER_A }
): Promise<{
  response: Response;
  body: UploadApiBody;
  uploadId?: string;
}> {
  const fileName = opts.fileName ?? "book.txt";
  const bytes = Buffer.from(text, "utf-8");
  const { POST: presign } = await import("@/app/api/pdf/upload/route");
  const presignRes = await presign(
    await buildRequest("/api/pdf/upload", {
      userId: opts.userId,
      body: {
        fileName,
        contentType: "text/plain",
        byteSize: bytes.length,
      },
    })
  );
  const presignBody = (await presignRes.json()) as {
    uploadId?: string;
    putUrl?: string;
    putHeaders?: Record<string, string>;
    error?: string;
  };
  if (presignRes.status !== 200 || !presignBody.uploadId) {
    return { response: presignRes, body: asUploadApiBody(presignBody) };
  }

  const minted = cookieFromResponse(presignRes);
  const auth = minted
    ? { cookie: minted }
    : opts.userId
      ? { userId: opts.userId }
      : {};

  const { PUT } = await import("@/app/api/pdf/upload/[id]/object/route");
  const putHeaders = { ...(presignBody.putHeaders || {}) };
  const putRes = await PUT(
    await buildRequest(presignBody.putUrl || `/api/pdf/upload/${presignBody.uploadId}/object`, {
      method: "PUT",
      ...auth,
      headers: putHeaders,
      rawBody: bytes,
    }),
    routeParams({ id: presignBody.uploadId })
  );
  if (putRes.status !== 200) {
    return { response: putRes, body: asUploadApiBody(await putRes.json()) };
  }

  const { POST: complete, GET: status } = await import(
    "@/app/api/pdf/upload/[id]/route"
  );
  const completeRes = await complete(
    await buildRequest(`/api/pdf/upload/${presignBody.uploadId}`, {
      method: "POST",
      ...auth,
      body: {},
    }),
    routeParams({ id: presignBody.uploadId })
  );
  let body = asUploadApiBody(await completeRes.json());
  if (completeRes.status !== 200) {
    return { response: completeRes, body };
  }

  if (body.status !== "ready") {
    const { extractUploadedDocument } = await import(
      "@/lib/uploads/extract"
    );
    const extracted = await extractUploadedDocument(presignBody.uploadId);
    if (extracted.status === "failed") {
      return {
        response: new Response(JSON.stringify(extracted), { status: 400 }),
        body: asUploadApiBody(extracted),
        uploadId: presignBody.uploadId,
      };
    }
    const readyRes = await status(
      await buildRequest(`/api/pdf/upload/${presignBody.uploadId}`, {
        method: "GET",
        ...auth,
      }),
      routeParams({ id: presignBody.uploadId })
    );
    return {
      response: readyRes,
      body: asUploadApiBody(await readyRes.json()),
      uploadId: presignBody.uploadId,
    };
  }

  return {
    response: completeRes,
    body,
    uploadId: presignBody.uploadId,
  };
}

export const UPLOAD_ID_A = "11111111-1111-4111-8111-111111111111";
export const UPLOAD_ID_B = "22222222-2222-4222-8222-222222222222";

/** Insert a job row directly, bypassing the create route. */
export async function seedJob(opts: {
  id: string;
  userId: string;
  pdfStoragePath: string;
  jobKind?: "stream" | "takehome";
  status?: string;
  catalogVoiceId?: string | null;
  providerVoiceId?: string;
  model?: string;
  segments?: unknown;
  audioStoragePath?: string | null;
  totalSections?: number;
  charCount?: number;
}): Promise<void> {
  await execute(
    `INSERT INTO jobs (
       id, user_id, book_title, voice_name, status, progress, pdf_storage_path,
       generation_mode, job_kind, tts_provider, provider_voice_id,
       catalog_voice_id, tts_options, char_count, next_section_index,
       segments_json, audio_storage_path, total_sections, stream_max_chars,
       stream_cursor, stream_chars_used
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.id,
      opts.userId,
      "Test Book",
      "Test Narrator",
      opts.status ?? "queued",
      0,
      opts.pdfStoragePath,
      "stock",
      opts.jobKind ?? "takehome",
      "openrouter",
      opts.providerVoiceId ?? "Achernar",
      opts.catalogVoiceId ?? null,
      JSON.stringify({ model: opts.model ?? "google/gemini-2.5-flash-tts" }),
      opts.charCount ?? 100,
      0,
      opts.segments ? JSON.stringify(opts.segments) : null,
      opts.audioStoragePath ?? null,
      opts.totalSections ?? 0,
      54_000,
      0,
      0,
    ]
  );
}

export async function jobRow(id: string) {
  const { queryOne } = await import("@/lib/turso");
  return queryOne<Record<string, unknown>>(`SELECT * FROM jobs WHERE id = ?`, [
    id,
  ]);
}
