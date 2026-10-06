import fs from "fs/promises";
import path from "path";
import { createReadStream } from "fs";
import { Readable } from "stream";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { isR2Configured, openObject, uploadFile as r2UploadFile, uploadFileFromPath as r2UploadFileFromPath, downloadFileToPath as r2DownloadFileToPath, getFile as r2GetFile, deleteFile as r2DeleteFile, listFiles as r2ListFiles, getDownloadUrl as r2GetDownloadUrl, getPlaybackUrl as r2GetPlaybackUrl } from "@/lib/r2-storage";

const STORAGE_ROOT = process.env.STORAGE_PATH || (process.env.VERCEL ? "/tmp" : "./data/storage");

// Ensure storage directories exist
const DIRECTORIES = ["pdfs", "audiobooks", "previews", "clones", "tts-cache"];

async function ensureDirectories() {
  for (const dir of DIRECTORIES) {
    const fullPath = path.join(STORAGE_ROOT, dir);
    await fs.mkdir(fullPath, { recursive: true });
  }
}

// Initialize on module load
ensureDirectories().catch(console.error);

/**
 * Get the full filesystem path for a storage path
 */
export function getFullPath(storagePath: string): string {
  return path.join(STORAGE_ROOT, storagePath);
}

/**
 * Upload a file to storage (R2 when configured, local filesystem for dev only)
 */
export async function uploadFile(
  directory: string,
  filename: string,
  data: Buffer | ArrayBuffer | Uint8Array,
  contentType?: string
): Promise<{ path: string; size: number }> {
  let buffer: Buffer;
  if (Buffer.isBuffer(data)) {
    buffer = data;
  } else if (data instanceof ArrayBuffer) {
    buffer = Buffer.from(data);
  } else {
    buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }

  const storagePath = `${directory}/${filename}`;

  if (isR2Configured()) {
    await r2UploadFile(storagePath, buffer, contentType || "application/octet-stream");
  } else {
    // Dev-only local fallback
    const filePath = path.join(STORAGE_ROOT, storagePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);
  }

  return {
    path: storagePath,
    size: buffer.length,
  };
}

/** Upload a file already on disk. Does not read it into one buffer. */
export async function uploadFileFromPath(
  directory: string,
  filename: string,
  localPath: string,
  contentType?: string
): Promise<{ path: string; size: number }> {
  const storagePath = `${directory}/${filename}`;
  const size = (await fs.stat(localPath)).size;
  if (isR2Configured()) {
    await r2UploadFileFromPath(storagePath, localPath, contentType || "application/octet-stream");
  } else {
    const filePath = path.join(STORAGE_ROOT, storagePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await pipeline(createReadStream(localPath), createWriteStream(filePath));
  }
  return { path: storagePath, size };
}

/** Copy a stored object onto a local path without buffering it. */
export async function downloadFileToPath(storagePath: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if (isR2Configured()) {
    await r2DownloadFileToPath(storagePath, dest);
    return;
  }
  await pipeline(createReadStream(getFullPath(storagePath)), createWriteStream(dest));
}

/**
 * Download a file from storage (R2 when configured, local filesystem for dev only)
 */
export async function downloadFile(storagePath: string): Promise<Buffer> {
  if (isR2Configured()) {
    return r2GetFile(storagePath);
  }

  // Dev-only local fallback
  const filePath = path.join(STORAGE_ROOT, storagePath);
  return fs.readFile(filePath);
}

/**
 * Check if a file exists
 */
export async function fileExists(storagePath: string): Promise<boolean> {
  // H7: Use metadata check (HeadObject for R2, fs.access for local) instead of downloading entire file
  const meta = await getFileMetadata(storagePath);
  return meta !== null;
}

/**
 * Delete a file
 */
export async function deleteFile(storagePath: string): Promise<void> {
  if (isR2Configured()) {
    return r2DeleteFile(storagePath);
  }
  const filePath = path.join(STORAGE_ROOT, storagePath);
  await fs.unlink(filePath);
}

async function listLocalFiles(
  filesystemDirectory: string,
  storageDirectory: string
): Promise<string[]> {
  const entries = await fs.readdir(filesystemDirectory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const filesystemPath = path.join(filesystemDirectory, entry.name);
      const storagePath = path.posix.join(
        storageDirectory.replace(/\\/g, "/"),
        entry.name
      );
      if (entry.isDirectory()) {
        return listLocalFiles(filesystemPath, storagePath);
      }
      return entry.isFile() ? [storagePath] : [];
    })
  );
  return files.flat();
}

/**
 * List files in a directory
 */
export async function listFiles(directory: string): Promise<string[]> {
  if (isR2Configured()) {
    return r2ListFiles(directory);
  }
  const dirPath = path.join(STORAGE_ROOT, directory);
  try {
    return await listLocalFiles(dirPath, directory);
  } catch {
    return [];
  }
}

/**
 * Get file metadata
 */
export async function getFileMetadata(storagePath: string): Promise<{ size: number; modified: Date } | null> {
  if (isR2Configured()) {
    try {
      const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
      const { getR2Client } = await import("@/lib/r2-storage");
      const client = getR2Client();
      const bucket = process.env.R2_BUCKET_NAME || "echomancer-audio";
      const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: storagePath }));
      return { size: response.ContentLength || 0, modified: response.LastModified || new Date() };
    } catch {
      return null;
    }
  }
  try {
    const filePath = path.join(STORAGE_ROOT, storagePath);
    const stats = await fs.stat(filePath);
    return {
      size: stats.size,
      modified: stats.mtime,
    };
  } catch {
    return null;
  }
}

/**
 * Open a stored audiobook for a browser download. The body is unread.
 * Callers must send it with Content-Disposition: attachment — a 307 to the
 * storage proxy drops that save in desktop Chrome, Edge, and Firefox.
 */
export async function openDownloadBody(
  storagePath: string,
  signal?: AbortSignal
): Promise<{ body: ReadableStream<Uint8Array>; contentLength: number } | null> {
  const meta = await getFileMetadata(storagePath);
  if (!meta) return null;

  if (isR2Configured()) {
    const opened = await openObject(storagePath, null, { signal });
    return { body: opened.body, contentLength: opened.contentLength };
  }

  const nodeStream = createReadStream(getFullPath(storagePath));
  if (signal) {
    const abort = () => nodeStream.destroy();
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  return {
    body: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
    contentLength: meta.size,
  };
}

/** Ten-minute signed GET when R2 is configured. Null in local dev. */
export async function signedDownloadUrl(
  key: string,
  expiresIn = 600
): Promise<string | null> {
  if (!isR2Configured()) return null;
  return r2GetDownloadUrl(key, expiresIn);
}

/**
 * Browser-facing R2 URL for an object the caller has already authorized
 * (playback, or a named attachment). Null when R2 is not configured (local
 * dev and tests serve from disk through the proxy) or when the
 * `STORAGE_DIRECT_R2=0` kill switch puts bytes back through the function.
 */
export async function directObjectUrl(
  key: string,
  opts?: { downloadName?: string; now?: number }
): Promise<string | null> {
  if (!isR2Configured()) return null;
  if (process.env.STORAGE_DIRECT_R2?.trim() === "0") return null;
  return r2GetPlaybackUrl(key, opts);
}
