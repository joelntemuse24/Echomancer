/**
 * Unified Storage Interface
 * Automatically uses R2 in production, local filesystem in development
 * Also exports backward-compatible aliases for legacy call sites
 */
import { promises as fs } from "fs";
import path from "path";
import { createReadStream } from "fs";
import { Readable } from "stream";
import {
  uploadFile as r2UploadFile,
  getFile as r2GetFile,
  deleteFile as r2DeleteFile,
  getDownloadUrl as r2GetDownloadUrl,
  listFiles as r2ListFiles,
  isR2Configured,
} from "./r2-storage";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { S3Client } from "@aws-sdk/client-s3";

const STORAGE_PATH = process.env.STORAGE_PATH || "./data/storage";

export interface StorageFile {
  key: string;
  url: string;
  size: number;
}

// ───────────────────────────────────────────────
// New unified API (R2-aware)
// ───────────────────────────────────────────────

/**
 * Upload a file (uses R2 if configured, otherwise local)
 */
export async function upload(
  type: "pdfs" | "voices" | "audiobooks" | "temp",
  userId: string,
  filename: string,
  data: Buffer,
  contentType: string
): Promise<StorageFile> {
  const key = generateStorageKey(type, userId, filename);

  if (isR2Configured()) {
    const result = await r2UploadFile(key, data, contentType);
    return {
      key,
      url: result.url,
      size: data.length,
    };
  } else {
    const filePath = path.join(STORAGE_PATH, key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, data);

    return {
      key,
      url: `file://${filePath}`,
      size: data.length,
    };
  }
}

/**
 * Download a file (uses R2 if configured, otherwise local)
 */
export async function download(key: string): Promise<Buffer> {
  if (isR2Configured()) {
    return r2GetFile(key);
  } else {
    const filePath = path.join(STORAGE_PATH, key);
    return fs.readFile(filePath);
  }
}

/**
 * Delete a file
 */
export async function remove(key: string): Promise<void> {
  if (isR2Configured()) {
    await r2DeleteFile(key);
  } else {
    const filePath = key.startsWith("file://")
      ? key.slice(7)
      : path.join(STORAGE_PATH, key);
    await fs.unlink(filePath).catch(() => {});
  }
}

/**
 * Get a download URL (presigned for R2, direct path for local)
 */
export async function getUrl(key: string, expiresIn: number = 3600): Promise<string> {
  if (isR2Configured()) {
    return r2GetDownloadUrl(key, expiresIn);
  } else {
    return key.startsWith("file://") ? key.slice(7) : path.join(STORAGE_PATH, key);
  }
}

/**
 * Check which storage backend is active
 */
export function getStorageBackend(): "r2" | "local" {
  return isR2Configured() ? "r2" : "local";
}

function generateStorageKey(
  type: "pdfs" | "voices" | "audiobooks" | "temp",
  userId: string,
  filename: string
): string {
  const timestamp = Date.now();
  const sanitized = filename.replace(/[^a-zA-Z0-9.-]/g, "_");
  return `${type}/${userId}/${timestamp}_${sanitized}`;
}

// ───────────────────────────────────────────────
// Backward-compatible aliases (legacy call sites)
// ───────────────────────────────────────────────

/**
 * Upload a file — legacy signature
 * (directory, filename, data, contentType?)
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
    return { path: storagePath, size: buffer.length };
  } else {
    const dirPath = path.join(STORAGE_PATH, directory);
    await fs.mkdir(dirPath, { recursive: true });
    const filePath = path.join(dirPath, filename);
    await fs.writeFile(filePath, buffer);
    return { path: storagePath, size: buffer.length };
  }
}

/**
 * Download a file — legacy signature
 */
export async function downloadFile(storagePath: string): Promise<Buffer> {
  if (isR2Configured()) {
    return r2GetFile(storagePath);
  } else {
    const filePath = path.join(STORAGE_PATH, storagePath);
    return fs.readFile(filePath);
  }
}

/**
 * Delete a file — legacy signature
 */
export async function deleteFile(storagePath: string): Promise<void> {
  if (isR2Configured()) {
    await r2DeleteFile(storagePath);
  } else {
    const filePath = path.join(STORAGE_PATH, storagePath);
    await fs.unlink(filePath).catch(() => {});
  }
}

/**
 * Check if a file exists — legacy signature
 */
export async function fileExists(storagePath: string): Promise<boolean> {
  if (isR2Configured()) {
    try {
      const files = await r2ListFiles(storagePath);
      return files.some((f) => f === storagePath || f.startsWith(storagePath + "/"));
    } catch {
      return false;
    }
  } else {
    try {
      const filePath = path.join(STORAGE_PATH, storagePath);
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Get full local filesystem path — legacy signature
 * (always local; used by local file-serving API route)
 */
export function getFullPath(storagePath: string): string {
  return path.join(STORAGE_PATH, storagePath);
}

/**
 * Get public URL — legacy signature (synchronous)
 */
export function getPublicUrl(storagePath: string): string {
  const r2PublicUrl = process.env.R2_PUBLIC_URL;
  if (isR2Configured() && r2PublicUrl) {
    return `${r2PublicUrl}/${storagePath}`;
  }
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return `${baseUrl}/api/storage/${storagePath}`;
}

/**
 * Get file metadata — legacy signature
 */
export async function getFileMetadata(
  storagePath: string
): Promise<{ size: number; modified: Date } | null> {
  if (isR2Configured()) {
    try {
      const { S3Client } = await import("@aws-sdk/client-s3");
      const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
      const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
      const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
      const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
      const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "echomancer-audio";
      if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
        return null;
      }
      const client = new S3Client({
        region: "auto",
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: R2_ACCESS_KEY_ID,
          secretAccessKey: R2_SECRET_ACCESS_KEY,
        },
      });
      const response = await client.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: storagePath }));
      return { size: response.ContentLength || 0, modified: response.LastModified || new Date() };
    } catch {
      return null;
    }
  } else {
    try {
      const filePath = path.join(STORAGE_PATH, storagePath);
      const stats = await fs.stat(filePath);
      return { size: stats.size, modified: stats.mtime };
    } catch {
      return null;
    }
  }
}

/**
 * Download a file as a stream — legacy signature
 * (always local; used by local file-serving API route)
 */
export function downloadFileStream(storagePath: string): Readable {
  const filePath = path.join(STORAGE_PATH, storagePath);
  return createReadStream(filePath);
}
