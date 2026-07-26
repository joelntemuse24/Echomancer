import fs from "fs/promises";
import path from "path";
import { createReadStream } from "fs";
import { Readable } from "stream";
import { isR2Configured, uploadFile as r2UploadFile, getFile as r2GetFile, deleteFile as r2DeleteFile, listFiles as r2ListFiles } from "@/lib/r2-storage";

const STORAGE_ROOT = process.env.STORAGE_PATH || (process.env.VERCEL ? "/tmp" : "./data/storage");

// Ensure storage directories exist
const DIRECTORIES = ["pdfs", "voices", "audiobooks", "previews", "checkpoints"];

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
 * Get the public URL for a storage path (serves via Next.js API route)
 */
export function getPublicUrl(storagePath: string): string {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return `${baseUrl}/api/storage/${storagePath}`;
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
 * Download a file as a stream
 */
export function downloadFileStream(storagePath: string): Readable {
  const filePath = path.join(STORAGE_ROOT, storagePath);
  return createReadStream(filePath);
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
