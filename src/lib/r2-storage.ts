/**
 * Cloudflare R2 Storage Client
 * S3-compatible, zero egress fees
 */
import { config } from "dotenv";
if (process.env.NODE_ENV !== "production") config({ path: ".env.local" });
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { open, stat, type FileHandle } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import https from "https";
import {
  RangeNotSatisfiableError,
  isAbortError,
  singleByteRangeHeader,
} from "@/lib/storage/byte-range";

// R2 Configuration
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "echomancer-audio";
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

// Validate configuration
const isConfigured = R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY;

// Create S3 client for R2
function createR2Client(): S3Client {
  if (!isConfigured) {
    throw new Error("R2 credentials not configured. Check environment variables.");
  }

  const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  console.log(`[R2] Creating S3 client with endpoint: ${endpoint}, forcePathStyle: true`);

  return new S3Client({
    region: "auto",
    endpoint,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID!,
      secretAccessKey: R2_SECRET_ACCESS_KEY!,
    },
    forcePathStyle: true,
    // Default flexible checksums add x-amz-checksum-* headers the browser
    // will not send, which 403s a presigned PUT.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: new NodeHttpHandler({
      httpsAgent: new https.Agent({
        keepAlive: true,
        maxSockets: 50,
      }),
    }),
  });
}

// Singleton client
let r2Client: S3Client | null = null;

export function getR2Client(): S3Client {
  if (!r2Client) {
    r2Client = createR2Client();
  }
  return r2Client;
}

// Storage operations
export interface UploadResult {
  key: string;
  url: string;
  publicUrl?: string;
}

/**
 * Upload a file to R2
 */
export async function uploadFile(
  key: string,
  data: Buffer | Uint8Array | string,
  contentType: string,
  options?: { isPublic?: boolean }
): Promise<UploadResult> {
  const client = getR2Client();

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: data,
        ContentType: contentType,
      })
    );
  } catch (err: unknown) {
    console.error(`[R2] Upload failed for key=${key}:`, err instanceof Error ? err.name : err, err instanceof Error ? err.message : "");
    throw err;
  }

  const result: UploadResult = {
    key,
    url: getInternalUrl(key),
  };

  if (options?.isPublic && R2_PUBLIC_URL) {
    result.publicUrl = `${R2_PUBLIC_URL}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
  }

  return result;
}

const MIN_PART_BYTES = 8 * 1024 * 1024;
const DEFAULT_PART_MB = 16;
const DEFAULT_UPLOAD_CONCURRENCY = 6;
const UPLOAD_PART_ATTEMPTS = 3;
const UPLOAD_PART_BACKOFF_MS = 250;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Part size for multipart uploads. R2 requires at least 5 MB; we keep 8 MB. */
export function uploadPartBytes(): number {
  return Math.max(MIN_PART_BYTES, envInt("R2_UPLOAD_PART_MB", DEFAULT_PART_MB) * 1024 * 1024);
}

/** How many parts may be in flight at once. */
export function uploadConcurrency(): number {
  return envInt("R2_UPLOAD_CONCURRENCY", DEFAULT_UPLOAD_CONCURRENCY);
}

/**
 * Read `length` bytes starting at `offset` into `buf`.
 *
 * `offset` is relative to the virtual byte stream the uploader was given, so a
 * prefix can be spliced in front of a file without copying it on disk.
 */
export type ReadRange = (
  offset: number,
  length: number,
  buf: Buffer
) => Promise<void>;

async function readFromFile(
  fh: FileHandle,
  offset: number,
  length: number,
  buf: Buffer
): Promise<void> {
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await fh.read(
      buf,
      filled,
      length - filled,
      offset + filled
    );
    if (bytesRead === 0) {
      throw new Error(`Unexpected EOF reading ${length} bytes at offset ${offset}`);
    }
    filled += bytesRead;
  }
}

function isRetryableUploadError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const named = err as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  if (named.name === "AbortError") return false;
  const status = named.$metadata?.httpStatusCode;
  if (status != null) return status >= 500 || status === 429 || status === 408;
  // Transport failures (socket resets, timeouts) carry no HTTP status.
  return true;
}

async function uploadPartWithRetry(
  client: S3Client,
  input: {
    Bucket: string;
    Key: string;
    UploadId: string;
    PartNumber: number;
    Body: Buffer;
    ContentLength: number;
  }
): Promise<{ ETag?: string; PartNumber: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= UPLOAD_PART_ATTEMPTS; attempt += 1) {
    try {
      const uploaded = await client.send(new UploadPartCommand(input));
      return { ETag: uploaded.ETag, PartNumber: input.PartNumber };
    } catch (err) {
      lastError = err;
      if (attempt === UPLOAD_PART_ATTEMPTS || !isRetryableUploadError(err)) break;
      const delay = UPLOAD_PART_BACKOFF_MS * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/**
 * Upload `totalBytes` of a virtual stream to R2, reading parts concurrently.
 * Each worker owns its buffer, so no two reads share memory.
 */
export async function uploadRanged(
  key: string,
  contentType: string,
  totalBytes: number,
  readRange: ReadRange
): Promise<UploadResult> {
  const client = getR2Client();
  const partBytes = uploadPartBytes();

  if (totalBytes < partBytes) {
    const body = Buffer.alloc(totalBytes);
    if (totalBytes > 0) await readRange(0, totalBytes, body);
    await client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: totalBytes,
      })
    );
    return { key, url: getInternalUrl(key) };
  }

  const created = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    })
  );
  const uploadId = created.UploadId;
  if (!uploadId) throw new Error("R2 multipart upload missing id");

  const partCount = Math.ceil(totalBytes / partBytes);
  const parts: { ETag?: string; PartNumber: number }[] = new Array(partCount);
  let nextPart = 0;
  let failure: unknown = null;

  const worker = async (): Promise<void> => {
    while (failure === null) {
      const index = nextPart;
      nextPart += 1;
      if (index >= partCount) return;
      const offset = index * partBytes;
      const length = Math.min(partBytes, totalBytes - offset);
      const buffer = Buffer.alloc(length);
      try {
        await readRange(offset, length, buffer);
        const part = await uploadPartWithRetry(client, {
          Bucket: R2_BUCKET_NAME,
          Key: key,
          UploadId: uploadId,
          PartNumber: index + 1,
          Body: buffer,
          ContentLength: length,
        });
        parts[index] = part;
      } catch (err) {
        failure = failure ?? err;
        return;
      }
    }
  };

  try {
    const workers = Math.min(uploadConcurrency(), partCount);
    const settled = await Promise.allSettled(
      Array.from({ length: workers }, () => worker())
    );
    if (failure === null) {
      const rejected = settled.find((result) => result.status === "rejected");
      if (rejected && rejected.status === "rejected") failure = rejected.reason;
    }
    if (failure !== null) throw failure;

    parts.sort((a, b) => a.PartNumber - b.PartNumber);
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      })
    );
  } catch (err) {
    await client
      .send(
        new AbortMultipartUploadCommand({
          Bucket: R2_BUCKET_NAME,
          Key: key,
          UploadId: uploadId,
        })
      )
      .catch(() => {});
    throw err;
  }

  return { key, url: getInternalUrl(key) };
}

/** Stream a local file to R2. Never holds the whole object in one buffer. */
export async function uploadFileFromPath(
  key: string,
  filePath: string,
  contentType: string
): Promise<UploadResult> {
  const size = (await stat(filePath)).size;
  const fh = await open(filePath, "r");
  try {
    return await uploadRanged(key, contentType, size, (offset, length, buf) =>
      readFromFile(fh, offset, length, buf)
    );
  } finally {
    await fh.close();
  }
}

/**
 * Upload `prefix ++ file[skipBytes..EOF]` under `key`.
 *
 * The prefix is prepended on the fly so a caller can stamp a header (a WAV
 * header, say) onto a file that is already on disk without rewriting it.
 */
export async function uploadFileWithPrefix(
  key: string,
  prefix: Buffer,
  filePath: string,
  contentType: string,
  skipBytes = 0
): Promise<UploadResult> {
  const fileSize = (await stat(filePath)).size;
  if (skipBytes < 0 || skipBytes > fileSize) {
    throw new Error(`skipBytes ${skipBytes} outside file of ${fileSize} bytes`);
  }
  const fileBytes = fileSize - skipBytes;
  const totalBytes = prefix.length + fileBytes;
  const fh = await open(filePath, "r");
  try {
    return await uploadRanged(
      key,
      contentType,
      totalBytes,
      async (offset, length, buf) => {
        let written = 0;
        if (offset < prefix.length) {
          const fromPrefix = Math.min(length, prefix.length - offset);
          prefix.copy(buf, 0, offset, offset + fromPrefix);
          written = fromPrefix;
        }
        if (written < length) {
          await readFromFile(
            fh,
            skipBytes + offset - prefix.length + written,
            length - written,
            buf.subarray(written)
          );
        }
      }
    );
  } finally {
    await fh.close();
  }
}

/** Stream an R2 object onto disk. */
export async function downloadFileToPath(key: string, dest: string): Promise<void> {
  const client = getR2Client();
  const response = await client.send(
    new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key })
  );
  if (!response.Body) throw new Error("Empty response body from R2");
  await pipeline(response.Body as NodeJS.ReadableStream, createWriteStream(dest));
}

/** Browser PUT window for a whole-book source object. */
export const PRESIGN_EXPIRES_SECONDS = 30 * 60;

/**
 * Short-lived presigned PUT. Secrets stay on the server; the browser uploads
 * bytes straight to R2. Only `ContentType` is signed — `Content-Length` must
 * not be, because `fetch()` cannot set that header and some browsers omit it
 * or send chunked bodies, which R2 then rejects with HTTP 400.
 */
export async function getUploadUrl(
  key: string,
  options: {
    contentType: string;
    contentLength?: number;
    expiresIn?: number;
  }
): Promise<string> {
  const client = getR2Client();
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    ContentType: options.contentType,
  });
  return getSignedUrl(client, command, {
    expiresIn: options.expiresIn ?? PRESIGN_EXPIRES_SECONDS,
  });
}

/** Short-lived GET for a finished clip. Ten minutes unless overridden. */
export async function getDownloadUrl(key: string, expiresIn = 600): Promise<string> {
  const client = getR2Client();
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  });
  return getSignedUrl(client, command, { expiresIn });
}

/**
 * Every playback URL stays valid for at least 12 hours. A long audiobook keeps
 * seeking against the URL it was first given (Chrome media reuses a redirect
 * target for later range requests), so a short expiry would 403 mid-book.
 */
export const PLAYBACK_URL_TTL_SECONDS = 13 * 60 * 60;

/** How long a browser may reuse the `/api/storage` redirect before asking again. */
export const PLAYBACK_REDIRECT_MAX_AGE_SECONDS = 60 * 60;

/**
 * Presigned GET for playback or a named download, served by R2 directly.
 *
 * Audio bytes used to flow through a Vercel function on every range request,
 * which is what spent the Hobby origin-transfer allowance. The caller checks
 * ownership first; the signature is the only thing this URL carries.
 *
 * The signing time is floored to the hour so every request in that hour gets
 * the same URL, and the browser's HTTP cache can reuse bytes it already has.
 * A download name forces `attachment` and `application/octet-stream`; iOS
 * Safari plays `audio/*` inline even when told to save it.
 */
export async function getPlaybackUrl(
  key: string,
  opts?: { downloadName?: string; now?: number }
): Promise<string> {
  const now = opts?.now ?? Date.now();
  const hour = 60 * 60 * 1000;
  const signingDate = new Date(Math.floor(now / hour) * hour);
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    ...(opts?.downloadName
      ? {
          ResponseContentDisposition: `attachment; filename="${opts.downloadName}"`,
          ResponseContentType: "application/octet-stream",
        }
      : {}),
  });
  return getSignedUrl(getR2Client(), command, {
    expiresIn: PLAYBACK_URL_TTL_SECONDS,
    signingDate,
  });
}

/** PutObject fields that are safe to sign for a browser upload. */
export function presignPutObjectInput(
  key: string,
  contentType: string
): { Bucket: string; Key: string; ContentType: string } {
  return {
    Bucket: R2_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  };
}

export interface OpenedObject {
  statusCode: 200 | 206;
  contentType?: string;
  contentLength: number;
  contentRange?: string;
  /** Unread stream of the object or the requested range. Do not buffer it. */
  body: ReadableStream<Uint8Array>;
}

type ObjectSender = {
  send(
    command: GetObjectCommand,
    options?: { abortSignal?: AbortSignal }
  ): Promise<GetObjectCommandOutput>;
};

/**
 * Open an object for playback. A `Range` header is forwarded to R2 so a seek
 * fetches that slice only — the body is returned unread. Buffering the whole
 * audiobook before the first byte (the previous `getFile` path) made every
 * seek wait on a 40–70 MB download.
 */
export async function openObject(
  key: string,
  rangeHeader: string | null | undefined,
  options?: {
    signal?: AbortSignal;
    sender?: ObjectSender;
    bucket?: string;
  }
): Promise<OpenedObject> {
  const range = singleByteRangeHeader(rangeHeader);
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  if (options?.signal) {
    if (options.signal.aborted) abort.abort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }
  if (abort.signal.aborted) {
    const err = new Error("Aborted");
    err.name = "AbortError";
    throw err;
  }

  const sender: ObjectSender = options?.sender ?? {
    send: (command, sendOptions) => getR2Client().send(command, sendOptions),
  };

  let response: GetObjectCommandOutput;
  try {
    response = await sender.send(
      new GetObjectCommand({
        Bucket: options?.bucket ?? R2_BUCKET_NAME,
        Key: key,
        ...(range ? { Range: range } : {}),
      }),
      { abortSignal: abort.signal }
    );
  } catch (err) {
    if (isAbortError(err) || abort.signal.aborted) {
      const aborted = new Error("Aborted");
      aborted.name = "AbortError";
      throw aborted;
    }
    if (isAwsRangeError(err)) throw new RangeNotSatisfiableError();
    throw err;
  }

  const body = response.Body;
  if (!body || typeof body.transformToWebStream !== "function") {
    throw new Error("R2 object body is not streamable");
  }

  const raw = body.transformToWebStream();
  // Do not read the body here. A seek must be able to return headers before
  // the slice arrives, and acquiring a reader pulls immediately.
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!reader) reader = raw.getReader();
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        if (abort.signal.aborted || isAbortError(err)) {
          controller.close();
          return;
        }
        controller.error(err);
      }
    },
    cancel() {
      abort.abort();
      const pending = reader ? reader.cancel() : raw.cancel();
      pending.catch(() => {});
    },
  });

  const contentRange = response.ContentRange;
  const contentLength =
    response.ContentLength ?? lengthFromContentRange(contentRange);
  if (contentLength == null) {
    throw new Error("R2 object is missing Content-Length");
  }

  const partial = Boolean(contentRange);
  return {
    statusCode: partial ? 206 : 200,
    contentType: response.ContentType,
    contentLength,
    contentRange: partial ? contentRange : undefined,
    body: stream,
  };
}

function lengthFromContentRange(contentRange: string | undefined): number | undefined {
  const match = contentRange?.match(/bytes (\d+)-(\d+)\//);
  const startRaw = match?.[1];
  const endRaw = match?.[2];
  if (!startRaw || !endRaw) return undefined;
  const start = Number.parseInt(startRaw, 10);
  const end = Number.parseInt(endRaw, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return end - start + 1;
}

function isAwsRangeError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const named = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return named.name === "InvalidRange" || named.$metadata?.httpStatusCode === 416;
}

/**
 * Get file content as buffer.
 * Playback must use {@link openObject} — this reads the entire object.
 */
export async function getFile(key: string): Promise<Buffer> {
  const client = getR2Client();

  const response = await client.send(
    new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    })
  );

  if (!response.Body) {
    throw new Error("Empty response body from R2");
  }

  const chunks: Buffer[] = [];
  const stream = response.Body as NodeJS.ReadableStream;

  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * Delete a file from R2
 */
export async function deleteFile(key: string): Promise<void> {
  const client = getR2Client();

  await client.send(
    new DeleteObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    })
  );
}

/**
 * List files in a prefix
 */
export async function listFiles(prefix?: string): Promise<string[]> {
  const client = getR2Client();
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET_NAME,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    keys.push(...(response.Contents || []).map((obj) => obj.Key!).filter(Boolean));
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

/**
 * Get the internal R2 URL for a key
 */
function getInternalUrl(key: string): string {
  return `https://${R2_BUCKET_NAME}.${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
}

// Check if R2 is properly configured
export function isR2Configured(): boolean {
  return !!isConfigured;
}
