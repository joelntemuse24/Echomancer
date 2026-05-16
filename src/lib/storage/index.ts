import fs from "fs/promises";
import path from "path";
import { createReadStream } from "fs";
import { Readable } from "stream";

const STORAGE_ROOT = process.env.STORAGE_PATH || "./data/storage";

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
  const rawAppUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const baseUrl = (rawAppUrl.includes("localhost") || rawAppUrl.includes("ngrok"))
    ? "https://echomancer-v2.vercel.app"
    : rawAppUrl;
  return `${baseUrl}/api/storage/${storagePath}`;
}

/**
 * Upload a file to local storage
 */
export async function uploadFile(
  directory: string,
  filename: string,
  data: Buffer | ArrayBuffer | Uint8Array,
  contentType?: string
): Promise<{ path: string; size: number }> {
  const dirPath = path.join(STORAGE_ROOT, directory);
  await fs.mkdir(dirPath, { recursive: true });

  const filePath = path.join(dirPath, filename);
  let buffer: Buffer;
  if (Buffer.isBuffer(data)) {
    buffer = data;
  } else if (data instanceof ArrayBuffer) {
    buffer = Buffer.from(data);
  } else {
    buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }

  await fs.writeFile(filePath, buffer);

  return {
    path: `${directory}/${filename}`,
    size: buffer.length,
  };
}

/**
 * Download a file from local storage
 */
export async function downloadFile(storagePath: string): Promise<Buffer> {
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
  try {
    const filePath = path.join(STORAGE_ROOT, storagePath);
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a file
 */
export async function deleteFile(storagePath: string): Promise<void> {
  const filePath = path.join(STORAGE_ROOT, storagePath);
  await fs.unlink(filePath);
}

/**
 * List files in a directory
 */
export async function listFiles(directory: string): Promise<string[]> {
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
