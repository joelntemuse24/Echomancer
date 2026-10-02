/**
 * Fetch one section from the Apify actor utils/youtube-link.
 * APIFY_TOKEN is sent as a bearer header and is never logged.
 *
 * The run is long-polled (waitForFinish, max 60s) instead of a 1.5s sleep.
 * The charge read overlaps the file download. audioQuality stays "best"
 * and format is omitted, so the actor keeps the original container.
 */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  apifyClipInput,
  apifyFailureCode,
  apifyLogSignal,
  apifyUsdFromRun,
  apifyWaitSeconds,
  APIFY_MAX_RUN_USD,
  CLIP_PROXY_BYTE_CAP,
  CLIP_WALL_MS,
  scrubToken,
  type ClipErrorCode,
} from "@/lib/youtube/clip-policy";

const ACTOR = "utils~youtube-link";
const API = "https://api.apify.com/v2";
/** Immediate, then 1s, then 1.5s. Overlaps the download. The old loop slept 2s four times before the file started. */
const BILL_DELAYS_MS = [0, 1_000, 1_500];

export type SectionDownload =
  | { ok: true; file: string; bytes: number; runId: string; usd: number }
  | { ok: false; code: ClipErrorCode; bytes: number; runId: string | null; usd: number };

type RunData = {
  id?: string;
  status?: string;
  statusMessage?: string;
  defaultDatasetId?: string;
  usageTotalUsd?: number;
  chargedEventCounts?: Record<string, number>;
  startedAt?: string;
  finishedAt?: string;
};

type DatasetItem = {
  downloadUrl?: string;
  filename?: string;
  error?: string;
};

function authHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function asRun(body: unknown): RunData {
  const data = (body as { data?: RunData })?.data;
  return data && typeof data === "object" ? data : (body as RunData);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function actorRunMs(run: RunData): number | null {
  const start = Date.parse(String(run.startedAt || ""));
  const end = Date.parse(String(run.finishedAt || ""));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
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

/** File length in seconds. The dataset `duration` field is the whole video. */
export function probeMediaDurationSec(file: string): Promise<number | null> {
  const bin = process.env.FFPROBE_PATH?.trim() || "ffprobe";
  return new Promise((resolve) => {
    const child = spawn(
      bin,
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += String(chunk);
    });
    child.once("error", () => resolve(null));
    child.once("exit", (code) => {
      if (code !== 0) return resolve(null);
      const n = Number(out.trim());
      resolve(Number.isFinite(n) && n > 0 ? n : null);
    });
  });
}

export async function downloadYoutubeSection(opts: {
  token: string;
  videoId: string;
  startSec: number;
  endSec: number;
  cwd: string;
  fetchImpl?: typeof fetch;
  probeImpl?: (file: string) => Promise<number | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SectionDownload> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const probe = opts.probeImpl ?? probeMediaDurationSec;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const startedAt = now();
  const deadline = startedAt + CLIP_WALL_MS;
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

  const abortRun = async () => {
    if (!runId) return;
    await fetchImpl(`${API}/actor-runs/${runId}/abort`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
  };

  const rememberUsd = (run: RunData) => {
    const next = apifyUsdFromRun(run);
    if (next > 0) usd = next;
  };

  try {
    const startUrl = new URL(`${API}/acts/${ACTOR}/runs`);
    startUrl.searchParams.set("maxTotalChargeUsd", String(APIFY_MAX_RUN_USD));
    startUrl.searchParams.set("timeout", String(Math.ceil(CLIP_WALL_MS / 1000)));
    const firstWait = apifyWaitSeconds(deadline - now());
    if (firstWait > 0) startUrl.searchParams.set("waitForFinish", String(firstWait));
    const started = await fetchImpl(startUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(Math.max(1_000, deadline - now())),
    });
    if (!started.ok) return fail(started.status === 402 ? "budget" : "unavailable");
    let run = asRun(await started.json());
    runId = run.id ?? null;
    rememberUsd(run);
    if (!runId) return fail("unavailable");

    let status = run.status || "READY";
    let datasetId = run.defaultDatasetId;
    let message = run.statusMessage || "";
    while (status === "READY" || status === "RUNNING") {
      const remain = deadline - now();
      if (remain <= 0) {
        await abortRun();
        return fail("timeout");
      }
      const wait = apifyWaitSeconds(remain);
      if (wait <= 0) {
        await abortRun();
        return fail("timeout");
      }
      const polled = await fetchImpl(`${API}/actor-runs/${runId}?waitForFinish=${wait}`, {
        headers,
        signal: AbortSignal.timeout(Math.max(1_000, remain)),
      });
      if (!polled.ok) return fail("unavailable");
      run = asRun(await polled.json());
      status = run.status || status;
      datasetId = run.defaultDatasetId || datasetId;
      message = run.statusMessage || message;
      rememberUsd(run);
    }
    const waitMs = now() - startedAt;

    const readItem = async (): Promise<DatasetItem | null> => {
      if (!datasetId) return null;
      const itemsRes = await fetchImpl(`${API}/datasets/${datasetId}/items`, {
        headers,
        signal: AbortSignal.timeout(Math.max(1_000, deadline - now())),
      }).catch(() => null);
      if (!itemsRes?.ok) return null;
      const items = (await itemsRes.json()) as DatasetItem[];
      return items.find((row) => row.downloadUrl) ?? items[0] ?? null;
    };

    const readLogSignal = async (): Promise<string> => {
      const res = await fetchImpl(`${API}/actor-runs/${runId}/log`, {
        headers,
        signal: AbortSignal.timeout(8_000),
      }).catch(() => null);
      if (!res?.ok) return "";
      const reader = res.body?.getReader();
      if (!reader) return apifyLogSignal(scrubToken(await res.text(), opts.token));
      const chunks: Buffer[] = [];
      let bytes = 0;
      while (true) {
        const step = await reader.read();
        if (step.done) break;
        const chunk = Buffer.from(step.value);
        chunks.push(chunk);
        bytes += chunk.length;
        while (bytes > 64_000 && chunks.length > 1) {
          const dropped = chunks.shift();
          if (dropped) bytes -= dropped.length;
        }
      }
      const tail = Buffer.concat(chunks).subarray(-64_000).toString("utf8");
      return apifyLogSignal(scrubToken(tail, opts.token));
    };

    const classify = async (item: DatasetItem | null): Promise<ClipErrorCode> => {
      const detail = `${message} ${item?.error || ""}`.trim();
      if (detail) return apifyFailureCode(detail);
      return apifyFailureCode(await readLogSignal());
    };

    if (status !== "SUCCEEDED") {
      const item = await readItem();
      const code = await classify(item);
      console.info(`[yt-clip] apify run=${runId} status=${status} usd=${usd} code=${code} waitMs=${waitMs}`);
      return fail(code);
    }
    const item = await readItem();
    if (!item?.downloadUrl) {
      const code = await classify(item);
      console.info(`[yt-clip] apify run=${runId} status=${status} usd=${usd} code=${code} waitMs=${waitMs}`);
      return fail(code);
    }

    const billStarted = now();
    const downloadStarted = now();
    const audioPromise = fetchImpl(item.downloadUrl, {
      headers,
      signal: AbortSignal.timeout(Math.max(1_000, deadline - now())),
    }).then((audio) => ({ audio, downloadMs: now() - downloadStarted }));
    const billPromise = (async () => {
      if (usd > 0) return { usd, billMs: now() - billStarted };
      for (const delay of BILL_DELAYS_MS) {
        if (now() >= deadline) break;
        if (delay) await sleep(delay);
        const billed = await fetchImpl(`${API}/actor-runs/${runId}`, {
          headers,
          signal: AbortSignal.timeout(5_000),
        }).catch(() => null);
        if (!billed?.ok) continue;
        rememberUsd(asRun(await billed.json()));
        if (usd > 0) break;
      }
      return { usd, billMs: now() - billStarted };
    })();

    const [audioWrap, billWrap] = await Promise.all([audioPromise, billPromise]);
    usd = billWrap.usd;
    const actorMs = actorRunMs(run);
    console.info(
      `[yt-clip] apify run=${runId} status=${status} usd=${usd} waitMs=${waitMs} actorMs=${actorMs ?? "-"} downloadMs=${audioWrap.downloadMs} billMs=${billWrap.billMs}`
    );

    const audio = audioWrap.audio;
    if (!audio.ok) return fail("unavailable");
    const body = await readCapped(audio, CLIP_PROXY_BYTE_CAP);
    if (!body.ok) return fail(body.code, body.bytes);
    const ext = (item.filename?.split(".").pop() || "m4a").replace(/[^\w]/g, "") || "m4a";
    const file = path.join(opts.cwd, `audio.${ext}`);
    await writeFile(file, body.buf);

    const asked = opts.endSec - opts.startSec;
    const probed = await probe(file);
    if (probed != null && probed > asked + 15) return fail("range_unsupported", body.buf.length);
    return { ok: true, file, bytes: body.buf.length, runId, usd };
  } catch (err) {
    await abortRun();
    const text = err instanceof Error ? err.message : "";
    const timed = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    console.info(
      `[yt-clip] apify ${timed ? "timeout" : "error"} ${scrubToken(text, opts.token).slice(0, 160)}`
    );
    return fail(timed ? "timeout" : "unavailable");
  }
}
