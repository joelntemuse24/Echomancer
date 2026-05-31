import fs from "fs/promises";
import path from "path";
import { createReadStream } from "fs";
import { Readable } from "stream";
import {
  isR2Configured,
  uploadFile as r2Upload,
  getFile as r2GetFile,
  deleteFile as r2Delete,
  listFiles as r2ListFiles,
  getDownloadUrl as r2GetDownloadUrl,
} from "@/lib/r2-storage";
import { HeadObjectCommand } from "@aws-sdk/client-s3";

const STORAGE_ROOT = process.env.STORAGE_PATH || (process.env.VERCEL ? "/tmp" : "./data/storage");

const DIRECTORIES = ["pdfs", "voices", "audiobooks", "previews", "checkpoints"];

async function ensureDirectories() {
  if (isR2Configured()) return;
  for (const dir of DIRECTORIES) {
    const fullPath = path.join(STORAGE_ROOT, dir);
    await fs.mkdir(fullPath, { recursive: true });
  }
}

ensureDirectories().catch(console.error);

function useR2(): boolean {
  return isR2Configured();
}

/**
 * Get the full filesystem path for a storage path (local mode only)
 */
export function getFullPath(storagePath: string): string {
  return path.join(STORAGE_ROOT, storagePath);
}

/**
 * Get the public URL for a storage path
 */
export function getPublicUrl(storagePath: string): string {
  const rawAppUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const baseUrl = (rawAppUrl.includes("localhost") || rawAppUrl.includes("ngrok"))
    ? "https://echomancer-v2.vercel.app"
    : rawAppUrl;
  return `${baseUrl}/api/storage/${storagePath}`;
}

function toBuffer(data: Buffer | ArrayBuffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Upload a file to storage (R2 when configured, local filesystem otherwise)
 */
export async function uploadFile(
  directory: string,
  filename: string,
  data: Buffer | ArrayBuffer | Uint8Array,
  contentType?: string
): Promise<{ path: string; size: number }> {
  const buffer = toBuffer(data);
  const key = `${directory}/${filename}`;

  if (useR2()) {
    await r2Upload(key, buffer, contentType || "application/octet-stream");
    return { path: key, size: buffer.length };
  }

  const dirPath = path.join(STORAGE_ROOT, directory);
  await fs.mkdir(dirPath, { recursive: true });
  const filePath = path.join(dirPath, filename);
  await fs.writeFile(filePath, buffer);
  return { path: key, size: buffer.length };
}

/**
 * Download a file from storage
 */
export async function downloadFile(storagePath: string): Promise<Buffer> {
  if (useR2()) {
    return r2GetFile(storagePath);
  }
  const filePath = path.join(STORAGE_ROOT, storagePath);
  return fs.readFile(filePath);
}

/**
 * Download a file as a stream.
 * For R2, falls back to buffered download wrapped in a Readable.
 */
export function downloadFileStream(storagePath: string): Readable {
  if (useR2()) {
    const passthrough = new Readable({ read() {} });
    r2GetFile(storagePath)
      .then((buf) => {
        passthrough.push(buf);
        passthrough.push(null);
      })
      .catch((err) => {
        passthrough.destroy(err instanceof Error ? err : new Error(String(err)));
      });
    return passthrough;
  }
  const filePath = path.join(STORAGE_ROOT, storagePath);
  return createReadStream(filePath);
}

/**
 * Check if a file exists in storage
 */
export async function fileExists(storagePath: string): Promise<boolean> {
  if (useR2()) {
    try {
      const { getR2ClientForHead, getR2BucketName } = await import("@/lib/r2-storage");
      const client = getR2ClientForHead();
      await client.send(
        new HeadObjectCommand({
          Bucket: getR2BucketName(),
          Key: storagePath,
        })
      );
      return true;
    } catch {
      return false;
    }
  }
  try {
    const filePath = path.join(STORAGE_ROOT, storagePath);
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a file from storage
 */
export async function deleteFile(storagePath: string): Promise<void> {
  if (useR2()) {
    await r2Delete(storagePath);
    return;
  }
  const filePath = path.join(STORAGE_ROOT, storagePath);
  await fs.unlink(filePath);
}

/**
 * List files in a directory/prefix
 */
export async function listFiles(directory: string): Promise<string[]> {
  if (useR2()) {
    const keys = await r2ListFiles(directory);
    return keys.map((k) => k.replace(`${directory}/`, ""));
  }
  const dirPath = path.join(STORAGE_ROOT, directory);
  try {
    return await fs.readdir(dirPath);
  } catch {
    return [];
  }
}

/**
 * Get file metadata
 */
export async function getFileMetadata(storagePath: string): Promise<{ size: number; modified: Date } | null> {
  if (useR2()) {
    try {
      const { getR2ClientForHead, getR2BucketName } = await import("@/lib/r2-storage");
      const client = getR2ClientForHead();
      const result = await client.send(
        new HeadObjectCommand({
          Bucket: getR2BucketName(),
          Key: storagePath,
        })
      );
      return {
        size: result.ContentLength ?? 0,
        modified: result.LastModified ?? new Date(),
      };
    } catch {
      return null;
    }
  }
  try {
    const filePath = path.join(STORAGE_ROOT, storagePath);
    const stats = await fs.stat(filePath);
    return { size: stats.size, modified: stats.mtime };
  } catch {
    return null;
  }
}

/**
 * Get a presigned download URL (R2 only, returns API route URL for local)
 */
export async function getPresignedUrl(storagePath: string): Promise<string> {
  if (useR2()) {
    return r2GetDownloadUrl(storagePath);
  }
  return `/api/storage/${storagePath}`;
}
