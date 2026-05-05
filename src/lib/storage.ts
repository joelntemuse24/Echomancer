/**
 * Unified Storage Interface
 * Automatically uses R2 in production, local filesystem in development
 */
import { promises as fs } from "fs";
import path from "path";
import { uploadFile, getFile, deleteFile, getDownloadUrl, generateKey, isR2Configured } from "./r2-storage";

const STORAGE_PATH = process.env.STORAGE_PATH || "./data/storage";

export interface StorageFile {
  key: string;
  url: string;
  size: number;
}

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
    const result = await uploadFile(key, data, contentType);
    return {
      key,
      url: result.url,
      size: data.length,
    };
  } else {
    // Local storage fallback
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
    return getFile(key);
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
    await deleteFile(key);
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
    return getDownloadUrl(key, expiresIn);
  } else {
    // For local files, just return the path
    // In a real app, you'd serve this via an API route
    return key.startsWith("file://") ? key.slice(7) : path.join(STORAGE_PATH, key);
  }
}

/**
 * Generate a unique storage key
 */
function generateStorageKey(
  type: "pdfs" | "voices" | "audiobooks" | "temp",
  userId: string,
  filename: string
): string {
  const timestamp = Date.now();
  const sanitized = filename.replace(/[^a-zA-Z0-9.-]/g, "_");
  return `${type}/${userId}/${timestamp}_${sanitized}`;
}

/**
 * Check which storage backend is active
 */
export function getStorageBackend(): "r2" | "local" {
  return isR2Configured() ? "r2" : "local";
}
