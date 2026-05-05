/**
 * Cloudflare R2 Storage Client
 * S3-compatible, zero egress fees
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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

  return new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID!,
      secretAccessKey: R2_SECRET_ACCESS_KEY!,
    },
  });
}

// Singleton client
let r2Client: S3Client | null = null;

function getR2Client(): S3Client {
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

  await client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: data,
      ContentType: contentType,
    })
  );

  const result: UploadResult = {
    key,
    url: getInternalUrl(key),
  };

  if (options?.isPublic && R2_PUBLIC_URL) {
    result.publicUrl = `${R2_PUBLIC_URL}/${key}`;
  }

  return result;
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

/**
 * Get file content as buffer
 */
export async function getFile(key: string): Promise<Buffer> {
  const client = getR2Client();

  const response = await client.send(
    new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    })
  );

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

  const response = await client.send(
    new ListObjectsV2Command({
      Bucket: R2_BUCKET_NAME,
      Prefix: prefix,
    })
  );

  return (response.Contents || []).map((obj) => obj.Key!).filter(Boolean);
}

/**
 * Get the internal R2 URL for a key
 */
function getInternalUrl(key: string): string {
  return `https://${R2_BUCKET_NAME}.${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${key}`;
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
