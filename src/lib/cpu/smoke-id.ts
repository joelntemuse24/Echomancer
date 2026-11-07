/**
 * Identifiers for the CPU smoke harness.
 *
 * A smoke run may insert one job, its cpu_tasks, and objects under
 * `audiobooks/<id>/`. The id is not a customer id, and deletion refuses
 * any other key. This module does not touch the database.
 */

const RUN_ID = /^cpusmoke[0-9a-f]{16}$/;

export function smokeRunIdFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 8) throw new Error("smoke id is 8 bytes");
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `cpusmoke${hex}`;
}

export function assertSmokeRunId(id: string): void {
  if (!RUN_ID.test(id)) throw new Error(`refusing smoke run id ${id}`);
}

export function smokeUserId(runId: string): string {
  assertSmokeRunId(runId);
  return runId;
}

export function smokeStoragePrefix(runId: string): string {
  assertSmokeRunId(runId);
  return `audiobooks/${runId}/`;
}

/** A key this run may delete. Anything else throws. */
export function assertDeletableSmokeKey(runId: string, key: string): void {
  const prefix = smokeStoragePrefix(runId);
  if (!key.startsWith(prefix) || key.includes("..") || key.includes("\\")) {
    throw new Error(`refusing to delete ${key}`);
  }
}

export function assertDispatchTaskId(taskId: string): string {
  const master = /^master:(cpusmoke[0-9a-f]{16}):([0-2])$/.exec(taskId);
  if (master?.[1]) return master[1];
  const concat = /^concat:(cpusmoke[0-9a-f]{16})$/.exec(taskId);
  if (concat?.[1]) return concat[1];
  throw new Error(`refusing to dispatch ${taskId}`);
}

/** Modal serves the endpoint at the host root. A path is a different URL. */
export function assertBareCpuEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("MODAL_CPU_URL must be an absolute http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("MODAL_CPU_URL must be http or https");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("MODAL_CPU_URL is the endpoint host, with no path");
  }
  if (url.search || url.hash) {
    throw new Error("MODAL_CPU_URL is the endpoint host, with no query");
  }
  return url.origin;
}
