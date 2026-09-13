/**
 * Enqueue a Trigger.dev task from Vercel.
 *
 * Production incident 2026-09-13: POST /api/pdf/upload/[id] complete returned
 * 200 with no error, but `upload.extract` only started as a child of the
 * minute cron `upload.drain`. `await import("@trigger.dev/sdk")` +
 * `tasks.trigger` either no-oped or failed without a run id; the catch in
 * `enqueueUploadExtract` swallowed it.
 *
 * This helper requires a run id:
 *   1. Official SDK (`configure` + `tasks.trigger`), CJS/ESM interop safe
 *   2. Public REST `POST /api/v1/tasks/:id/trigger` if the SDK returns none
 *   3. Short REST retries so a single blip is not a 60s drain wait
 */

import { AppError } from "@/lib/errors";
import * as triggerSdk from "@trigger.dev/sdk";

const DEFAULT_REST_ATTEMPTS = 3;
const REST_BACKOFF_MS = 250;

export function triggerApiBase(): string {
  return (
    process.env.TRIGGER_API_URL?.trim().replace(/\/$/, "") ||
    "https://api.trigger.dev"
  );
}

function secretKey(): string | undefined {
  const key = process.env.TRIGGER_SECRET_KEY?.trim();
  return key || undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runIdFromUnknown(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

type SdkTrigger = (
  taskId: string,
  payload: unknown,
  options?: { concurrencyKey?: string; idempotencyKey?: string }
) => Promise<unknown>;

type SdkModule = {
  configure?: (opts: { secretKey?: string; accessToken?: string }) => void;
  tasks?: { trigger?: SdkTrigger };
  default?: { tasks?: { trigger?: SdkTrigger } };
};

function sdkTriggerFn(): SdkTrigger | null {
  const mod = triggerSdk as SdkModule;
  const trigger = mod.tasks?.trigger ?? mod.default?.tasks?.trigger;
  return typeof trigger === "function" ? trigger : null;
}

function configureSdk(key: string): void {
  const configure = (triggerSdk as SdkModule).configure;
  if (typeof configure === "function") {
    configure({ secretKey: key, accessToken: key });
  }
}

export interface TriggerTaskOptions {
  concurrencyKey?: string;
  idempotencyKey?: string;
  /** REST attempts after the SDK miss. Complete uses 3; poll nudge uses 1. */
  restAttempts?: number;
}

export async function triggerTask(
  taskId: string,
  payload: unknown,
  options: TriggerTaskOptions = {}
): Promise<{ id: string }> {
  const key = secretKey();
  if (!key) {
    throw new AppError(
      "TRIGGER_NOT_CONFIGURED",
      "Background processing is not configured (TRIGGER_SECRET_KEY is missing).",
      503
    );
  }

  const viaSdk = await triggerViaSdk(key, taskId, payload, options);
  if (viaSdk) return viaSdk;

  const attempts = Math.max(1, options.restAttempts ?? DEFAULT_REST_ATTEMPTS);
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await triggerViaRest(key, taskId, payload, options);
    } catch (err) {
      lastError = err;
      if (attempt < attempts - 1) {
        await sleep(REST_BACKOFF_MS * (attempt + 1));
      }
    }
  }

  const detail =
    lastError instanceof Error
      ? lastError.message
      : String(lastError ?? "unknown");
  console.error(`[trigger] ${taskId} dispatch failed after ${attempts} REST attempt(s)`, detail);
  throw new AppError(
    "TRIGGER_DISPATCH_FAILED",
    `Could not enqueue ${taskId} on Trigger.dev.`,
    503
  );
}

async function triggerViaSdk(
  key: string,
  taskId: string,
  payload: unknown,
  options: TriggerTaskOptions
): Promise<{ id: string } | null> {
  try {
    configureSdk(key);
    const trigger = sdkTriggerFn();
    if (!trigger) return null;
    const sdkOptions: { concurrencyKey?: string; idempotencyKey?: string } = {};
    if (options.concurrencyKey) sdkOptions.concurrencyKey = options.concurrencyKey;
    if (options.idempotencyKey) sdkOptions.idempotencyKey = options.idempotencyKey;
    const handle = await trigger(
      taskId,
      payload,
      Object.keys(sdkOptions).length > 0 ? sdkOptions : undefined
    );
    const id = runIdFromUnknown(handle);
    return id ? { id } : null;
  } catch (err) {
    console.error(`[trigger] SDK trigger failed for ${taskId}; trying REST`, err);
    return null;
  }
}

async function triggerViaRest(
  key: string,
  taskId: string,
  payload: unknown,
  options: TriggerTaskOptions
): Promise<{ id: string }> {
  const url = `${triggerApiBase()}/api/v1/tasks/${encodeURIComponent(taskId)}/trigger`;
  const restOptions: Record<string, string> = {};
  if (options.concurrencyKey) restOptions.concurrencyKey = options.concurrencyKey;
  if (options.idempotencyKey) restOptions.idempotencyKey = options.idempotencyKey;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      payload,
      options: restOptions,
    }),
  });

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    throw new Error(
      `Trigger REST ${taskId} HTTP ${res.status}: ${text.slice(0, 240) || res.statusText}`
    );
  }

  const id = runIdFromUnknown(parsed);
  if (!id) {
    throw new Error(`Trigger REST ${taskId} returned no run id`);
  }
  return { id };
}
