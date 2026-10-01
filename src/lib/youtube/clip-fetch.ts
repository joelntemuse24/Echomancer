/**
 * Fetch one section from the Apify actor utils/youtube-link.
 * APIFY_TOKEN is sent as a bearer header and is never logged.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  apifyClipInput,
  CLIP_PROXY_BYTE_CAP,
  CLIP_WALL_MS,
  scrubToken,
  type ClipErrorCode,
} from "@/lib/youtube/clip-policy";

const ACTOR = "utils~youtube-link";
const API = "https://api.apify.com/v2";

export type SectionDownload =
  | { ok: true; file: string; bytes: number; runId: string; usd: number }
  | { ok: false; code: ClipErrorCode; bytes: number; runId: string | null; usd: number };

type RunData = {
  id?: string;
  status?: string;
  statusMessage?: string;
  defaultDatasetId?: string;
  usageTotalUsd?: number;
};

type DatasetItem = {
  downloadUrl?: string;
  filename?: string;
  duration?: number;
  error?: string;
};

function authHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function asRun(body: unknown): RunData {
  const data = (body as { data?: RunData })?.data;
  return data && typeof data === "object" ? data : (body as RunData);
}

function failureCode(message: string): ClipErrorCode {
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (/age|restricted|region|country|not available in your/i.test(message)) return "restricted";
  return "unavailable";
}

async function readCapped(
  response: Response,
  maxBytes: number
): Promise<{ ok: true; buf: Buffer } | { ok: false; code: "too_big"; bytes: number }> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) return { ok: false, code: "too_big", bytes: declared };
  const reader = response.body?.getReader();
  if (!reader) return { ok: false, code: "too_big", bytes: 0 };
  const chunks: Buffer[] = [];
  let bytes = 0;
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    const chunk = Buffer.from(step.value);
    bytes += chunk.length;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false, code: "too_big", bytes };
    }
    chunks.push(chunk);
  }
  return { ok: true, buf: Buffer.concat(chunks) };
}

export async function downloadYoutubeSection(opts: {
  token: string;
  videoId: string;
  startSec: number;
  endSec: number;
  cwd: string;
  fetchImpl?: typeof fetch;
}): Promise<SectionDownload> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const deadline = Date.now() + CLIP_WALL_MS;
  const input = apifyClipInput(opts.videoId, opts.startSec, opts.endSec);
  const headers = authHeaders(opts.token);
  let runId: string | null = null;
  let usd = 0;

  const fail = (code: ClipErrorCode, bytes = 0): SectionDownload => ({
    ok: false,
    code,
    bytes,
    runId,
    usd,
  });

  try {
    const started = await fetchImpl(`${API}/acts/${ACTOR}/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())),
    });
    if (!started.ok) return fail(started.status === 402 ? "budget" : "unavailable");
    const run = asRun(await started.json());
    runId = run.id ?? null;
    usd = Number(run.usageTotalUsd || 0);
    if (!runId) return fail("unavailable");

    let status = run.status || "READY";
    let datasetId = run.defaultDatasetId;
    let message = run.statusMessage || "";
    while (status === "READY" || status === "RUNNING") {
      if (Date.now() >= deadline) return fail("timeout");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const polled = await fetchImpl(`${API}/actor-runs/${runId}`, {
        headers,
        signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())),
      });
      if (!polled.ok) return fail("unavailable");
      const next = asRun(await polled.json());
      status = next.status || status;
      datasetId = next.defaultDatasetId || datasetId;
      message = next.statusMessage || message;
      usd = Number(next.usageTotalUsd ?? usd);
    }

    console.info(`[yt-clip] apify run=${runId} status=${status} usd=${usd}`);
    if (status !== "SUCCEEDED") return fail(failureCode(message));
    if (!datasetId) return fail("unavailable");

    const itemsRes = await fetchImpl(`${API}/datasets/${datasetId}/items`, {
      headers,
      signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())),
    });
    if (!itemsRes.ok) return fail("unavailable");
    const items = (await itemsRes.json()) as DatasetItem[];
    const item = items.find((row) => row.downloadUrl) ?? items[0];
    if (!item?.downloadUrl) return fail(item?.error ? failureCode(item.error) : "unavailable");
    const asked = opts.endSec - opts.startSec;
    if (typeof item.duration === "number" && item.duration > asked + 15) {
      return fail("range_unsupported");
    }

    const audio = await fetchImpl(item.downloadUrl, {
      headers,
      signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())),
    });
    if (!audio.ok) return fail("unavailable");
    const body = await readCapped(audio, CLIP_PROXY_BYTE_CAP);
    if (!body.ok) return fail(body.code, body.bytes);
    const ext = (item.filename?.split(".").pop() || "m4a").replace(/[^\w]/g, "") || "m4a";
    const file = path.join(opts.cwd, `audio.${ext}`);
    await writeFile(file, body.buf);
    return { ok: true, file, bytes: body.buf.length, runId, usd };
  } catch (err) {
    const text = err instanceof Error ? err.message : "";
    const timed = err instanceof Error && err.name === "TimeoutError";
    console.info(`[yt-clip] apify ${timed ? "timeout" : "error"} ${scrubToken(text, opts.token).slice(0, 160)}`);
    return fail(timed ? "timeout" : "unavailable");
  }
}
