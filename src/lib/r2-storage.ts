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
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
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

const MULTIPART_PART_BYTES = 8 * 1024 * 1024;

/** Stream a local file to R2. Never reads the whole object into one buffer. */
export async function uploadFileFromPath(
  key: string,
  filePath: string,
  contentType: string
): Promise<UploadResult> {
  const client = getR2Client();
  const size = (await stat(filePath)).size;
  if (size < MULTIPART_PART_BYTES) {
    await client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: createReadStream(filePath),
        ContentType: contentType,
        ContentLength: size,
      })
    );
  } else {
    const created = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        ContentType: contentType,
      })
    );
    const uploadId = created.UploadId;
    if (!uploadId) throw new Error("R2 multipart upload missing id");
    const fh = await open(filePath, "r");
    const parts: { ETag?: string; PartNumber: number }[] = [];
    try {
      let offset = 0;
      let partNumber = 1;
      const chunk = Buffer.alloc(MULTIPART_PART_BYTES);
      while (offset < size) {
        const length = Math.min(MULTIPART_PART_BYTES, size - offset);
        await fh.read(chunk, 0, length, offset);
        const uploaded = await client.send(
          new UploadPartCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: chunk.subarray(0, length),
            ContentLength: length,
          })
        );
        parts.push({ ETag: uploaded.ETag, PartNumber: partNumber });
        offset += length;
        partNumber += 1;
      }
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
    } finally {
      await fh.close();
    }
  }
  return { key, url: getInternalUrl(key) };
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

/**
 * Get a presigned URL for downloading a file
 */
export async function getDownloadUrl(key: string, expiresIn: number = 3600): Promise<string> {
  const client = getR2Client();

  const command = new GetObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  });

  return getSignedUrl(client, command, { expiresIn });
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

/**
 * Generate a unique key for a file
 */
export function generateKey(
  type: "pdfs" | "voices" | "audiobooks" | "temp",
  userId: string,
  filename: string
): string {
  const timestamp = Date.now();
  const sanitized = filename.replace(/[^a-zA-Z0-9.-]/g, "_");
  return `${type}/${userId}/${timestamp}_${sanitized}`;
}

// Check if R2 is properly configured
export function isR2Configured(): boolean {
  return !!isConfigured;
}

// Fallback to local storage for development
export function shouldUseLocalStorage(): boolean {
  return !isR2Configured();
}
