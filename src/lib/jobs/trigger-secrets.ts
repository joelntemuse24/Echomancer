/**
 * Secrets the Trigger take-home runtime must have. Missing any of these
 * must fail the task immediately — a queued job with no keys just stalls.
 */

function isMemoryTurso(url: string | undefined): boolean {
  return !url || url === ":memory:" || url.startsWith("file:");
}

function isDeployed(): boolean {
  return (
    process.env.VERCEL === "1" ||
    process.env.TRIGGER === "1" ||
    Boolean(process.env.TRIGGER_SECRET_KEY) ||
    process.env.NODE_ENV === "production"
  );
}

function hasR2(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET_NAME
  );
}

export function assertTakehomeWorkerSecrets(): void {
  const missing: string[] = [];

  if (
    !process.env.FISH_API_KEY?.trim() &&
    !process.env.FISH_AUDIO_API_KEY?.trim()
  ) {
    missing.push("FISH_API_KEY");
  }

  if (!process.env.TURSO_DATABASE_URL?.trim()) {
    missing.push("TURSO_DATABASE_URL");
  } else if (
    !isMemoryTurso(process.env.TURSO_DATABASE_URL) &&
    !process.env.TURSO_AUTH_TOKEN?.trim()
  ) {
    missing.push("TURSO_AUTH_TOKEN");
  }

  if (!process.env.INTERNAL_JOB_SECRET?.trim() && isDeployed()) {
    missing.push("INTERNAL_JOB_SECRET");
  }

  if (isDeployed() && !hasR2() && !process.env.STORAGE_PATH) {
    missing.push("R2_ACCOUNT_ID");
  }

  if (missing.length > 0) {
    throw new Error(
      `Take-home worker missing secrets: ${missing.join(", ")}`
    );
  }
}
