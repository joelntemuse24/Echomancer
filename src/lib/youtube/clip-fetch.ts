/**
 * Fetch one YouTube section through Apify. Two actors share the work:
 *
 * - `link`    utils/youtube-link — timeframe cut, original container. Fast on
 *             short sources, slows down as the source gets longer.
 * - `segment` entertained_rattlesnake/youtube-audio-segment-downloader —
 *             yt-dlp --download-sections, WAV out. Flat ~30–45s regardless of
 *             source length, but YouTube's bot check can block it where the
 *             link actor gets through.
 *
 * The source length picks the primary actor (`clipActorOrder`); a classified
 * failure falls back to the other actor once. APIFY_TOKEN is sent as a bearer
 * header and is never logged.
 *
 * Segment-actor gotchas (benched 2026-10-02): the run reports SUCCEEDED even
 * when the video failed — the audio and the failure detail (`FAILED_<id>.json`)
 * live in the run's key-value store, not the dataset. `transcribe` stays false.
 */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  apifyClipInput,
  apifyFailureCode,
  apifyLogSignal,
  apifySegmentClipInput,
  apifySegmentFloorUsd,
  apifyUsdFromRun,
  apifyWaitSeconds,
  APIFY_RESULT_USD,
  clipActorMaxRunUsd,
  clipActorOrder,
  clipAttemptWallMs,
  clipFallbackable,
  CLIP_ACTOR_IDS,
  CLIP_PROXY_BYTE_CAP,
  scrubToken,
  type ClipActor,
  type ClipErrorCode,
} from "@/lib/youtube/clip-policy";

const API = "https://api.apify.com/v2";
/** Immediate, then 1s, then 1.5s. Overlaps the download. The old loop slept 2s four times before the file started. */
const BILL_DELAYS_MS = [0, 1_000, 1_500];

export type SectionDownload =
  | { ok: true; file: string; bytes: number; runId: string; usd: number; actor: ClipActor }
  | { ok: false; code: ClipErrorCode; bytes: number; runId: string | null; usd: number; actor: ClipActor };

type RunData = {
  id?: string;
  status?: string;
  statusMessage?: string;
  defaultDatasetId?: string;
  defaultKeyValueStoreId?: string;
  usageTotalUsd?: number;
  chargedEventCounts?: Record<string, number>;
  startedAt?: string;
  finishedAt?: string;
};

type DatasetItem = {
  downloadUrl?: string;
  filename?: string;
  error?: string;
  /** Whole video, in seconds. Not the cut file. */
  duration?: number;
};

type AudioPointer = { url: string; filename: string };

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

type AttemptOpts = {
  token: string;
  videoId: string;
  startSec: number;
  endSec: number;
  cwd: string;
  actor: ClipActor;
  why: string;
  wallMs: number;
  fetchImpl: typeof fetch;
  probe: (file: string) => Promise<number | null>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

/** The link actor puts `downloadUrl` in the dataset. */
async function readLinkAudio(
  opts: AttemptOpts,
  run: RunData,
  deadline: number
): Promise<{ audio: AudioPointer | null; item: DatasetItem | null }> {
  const datasetId = run.defaultDatasetId;
  if (!datasetId) return { audio: null, item: null };
  const itemsRes = await opts
    .fetchImpl(`${API}/datasets/${datasetId}/items`, {
      headers: authHeaders(opts.token),
      signal: AbortSignal.timeout(Math.max(1_000, deadline - opts.now())),
    })
    .catch(() => null);
  if (!itemsRes?.ok) return { audio: null, item: null };
  const items = (await itemsRes.json()) as DatasetItem[];
  const item = items.find((row) => row.downloadUrl) ?? items[0] ?? null;
  if (!item?.downloadUrl) return { audio: null, item };
  return { audio: { url: item.downloadUrl, filename: item.filename || "audio.m4a" }, item };
}

/** Pull a failure reason out of the segment actor's `FAILED_<videoId>.json` record. */
function segmentFailureDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    for (const key of ["error", "message", "reason", "statusMessage", "details"]) {
      const value = parsed?.[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return JSON.stringify(parsed).slice(0, 500);
  } catch {
    return body.slice(0, 500);
  }
}

/**
 * The segment actor stores the audio in the run's key-value store and writes
 * failures there as `FAILED_<videoId>.json`. The dataset only carries a
 * transcript stub, and the run status says SUCCEEDED either way.
 */
async function readSegmentAudio(
  opts: AttemptOpts,
  run: RunData,
  deadline: number
): Promise<{ audio: AudioPointer | null; failure: string }> {
  const storeId = run.defaultKeyValueStoreId;
  if (!storeId) return { audio: null, failure: "" };
  const headers = authHeaders(opts.token);
  const keysRes = await opts
    .fetchImpl(`${API}/key-value-stores/${storeId}/keys`, {
      headers,
      signal: AbortSignal.timeout(Math.max(1_000, deadline - opts.now())),
    })
    .catch(() => null);
  if (!keysRes?.ok) return { audio: null, failure: "" };
  const body = (await keysRes.json().catch(() => null)) as {
    data?: { items?: { key?: string }[] };
  } | null;
  const keys = (body?.data?.items ?? [])
    .map((item) => item.key)
    .filter((key): key is string => Boolean(key));
  const audioKey = keys.find((key) => /\.(wav|mp3|m4a|opus|webm|ogg)$/i.test(key));
  if (audioKey) {
    return {
      audio: {
        url: `${API}/key-value-stores/${storeId}/records/${encodeURIComponent(audioKey)}`,
        filename: audioKey,
      },
      failure: "",
    };
  }
  const failedKey =
    keys.find((key) => new RegExp(`^FAILED_${opts.videoId}`, "i").test(key)) ??
    keys.find((key) => /^FAILED_/i.test(key));
  if (!failedKey) return { audio: null, failure: "" };
  const record = await opts
    .fetchImpl(`${API}/key-value-stores/${storeId}/records/${encodeURIComponent(failedKey)}`, {
      headers,
      signal: AbortSignal.timeout(Math.max(1_000, deadline - opts.now())),
    })
    .catch(() => null);
  if (!record?.ok) return { audio: null, failure: "" };
  const text = await record.text().catch(() => "");
  return { audio: null, failure: segmentFailureDetail(scrubToken(text, opts.token)) };
}

async function runActorAttempt(opts: AttemptOpts): Promise<SectionDownload> {
  const { fetchImpl, now, sleep } = opts;
  const startedAt = now();
  const deadline = startedAt + opts.wallMs;
  const input =
    opts.actor === "segment"
      ? apifySegmentClipInput(opts.videoId, opts.startSec, opts.endSec)
      : apifyClipInput(opts.videoId, opts.startSec, opts.endSec);
  const headers = authHeaders(opts.token);
  let runId: string | null = null;
  let usd = 0;

  const fail = (code: ClipErrorCode, bytes = 0): SectionDownload => ({
    ok: false,
    code,
    bytes,
    runId,
    usd,
    actor: opts.actor,
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
    const startUrl = new URL(`${API}/acts/${CLIP_ACTOR_IDS[opts.actor]}/runs`);
    startUrl.searchParams.set("maxTotalChargeUsd", String(clipActorMaxRunUsd(opts.actor)));
    startUrl.searchParams.set("timeout", String(Math.ceil(opts.wallMs / 1000)));
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
      message = run.statusMessage || message;
      rememberUsd(run);
    }
    const waitMs = now() - startedAt;

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

    let audio: AudioPointer | null = null;
    let itemError = "";
    if (opts.actor === "segment") {
      const out = await readSegmentAudio(opts, run, deadline);
      audio = out.audio;
      itemError = out.failure;
    } else {
      const out = await readLinkAudio(opts, run, deadline);
      audio = out.audio;
      itemError = out.item?.error || "";
    }

    if (status !== "SUCCEEDED" || !audio) {
      const detail = `${message} ${itemError}`.trim();
      const code = detail ? apifyFailureCode(detail) : apifyFailureCode(await readLogSignal());
      console.info(
        `[yt-clip] apify actor=${opts.actor} why=${opts.why} run=${runId} status=${status} usd=${usd} code=${code} waitMs=${waitMs}`
      );
      return fail(code);
    }

    const billStarted = now();
    const downloadStarted = now();
    const audioPromise = fetchImpl(audio.url, {
      headers,
      signal: AbortSignal.timeout(Math.max(1_000, deadline - now())),
    }).then((res) => ({ res, downloadMs: now() - downloadStarted }));
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
      `[yt-clip] apify actor=${opts.actor} why=${opts.why} run=${runId} status=${status} usd=${usd} waitMs=${waitMs} actorMs=${actorMs ?? "-"} downloadMs=${audioWrap.downloadMs} billMs=${billWrap.billMs}`
    );

    const res = audioWrap.res;
    if (!res.ok) return fail("unavailable");
    const body = await readCapped(res, CLIP_PROXY_BYTE_CAP);
    if (!body.ok) return fail(body.code, body.bytes);
    if (body.buf.length === 0) return fail("unavailable");
    const ext = (audio.filename.split(".").pop() || "m4a").replace(/[^\w]/g, "") || "m4a";
    const file = path.join(opts.cwd, `audio.${ext}`);
    await writeFile(file, body.buf);

    const asked = opts.endSec - opts.startSec;
    const probed = await opts.probe(file);
    if (probed == null) return fail("unavailable", body.buf.length);
    if (probed > asked + 15) return fail("range_unsupported", body.buf.length);
    if (usd <= 0) {
      usd = opts.actor === "segment" ? apifySegmentFloorUsd(asked) : APIFY_RESULT_USD;
    }
    return { ok: true, file, bytes: body.buf.length, runId, usd, actor: opts.actor };
  } catch (err) {
    await abortRun();
    const text = err instanceof Error ? err.message : "";
    const timed = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    console.info(
      `[yt-clip] apify actor=${opts.actor} ${timed ? "timeout" : "error"} ${scrubToken(text, opts.token).slice(0, 160)}`
    );
    return fail(timed ? "timeout" : "unavailable");
  }
}

export async function downloadYoutubeSection(opts: {
  token: string;
  videoId: string;
  startSec: number;
  endSec: number;
  cwd: string;
  /** Source video length in seconds, from the queue-time videos.list call. Unknown rows default to the link actor. */
  videoSeconds?: number | null;
  fetchImpl?: typeof fetch;
  probeImpl?: (file: string) => Promise<number | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SectionDownload> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const probe = opts.probeImpl ?? probeMediaDurationSec;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const videoSeconds =
    opts.videoSeconds != null && Number.isFinite(opts.videoSeconds) && opts.videoSeconds > 0
      ? opts.videoSeconds
      : null;
  const order = clipActorOrder(videoSeconds);

  let last: SectionDownload | null = null;
  let totalUsd = 0;
  for (let i = 0; i < order.length; i += 1) {
    const actor = order[i]!;
    const why =
      i === 0
        ? actor === "segment"
          ? `long-source-${Math.round(videoSeconds ?? 0)}s`
          : "short-source"
        : `fallback-after-${last && !last.ok ? last.code : "unknown"}`;
    const attempt = await runActorAttempt({
      token: opts.token,
      videoId: opts.videoId,
      startSec: opts.startSec,
      endSec: opts.endSec,
      cwd: opts.cwd,
      actor,
      why,
      wallMs: clipAttemptWallMs(actor, videoSeconds),
      fetchImpl,
      probe,
      now,
      sleep,
    });
    totalUsd += attempt.usd;
    if (attempt.ok) {
      return totalUsd > attempt.usd ? { ...attempt, usd: totalUsd } : attempt;
    }
    if (last && !last.ok && attempt.code === "unavailable" && last.code !== "unavailable") {
      // Keep the specific reason over the generic one when both actors fail.
      last = { ...attempt, code: last.code };
    } else {
      last = attempt;
    }
    const next = order[i + 1];
    if (!next || !clipFallbackable(attempt.code)) break;
    console.info(`[yt-clip] apify fallback from=${actor} to=${next} after=${attempt.code}`);
  }
  const out = last ?? {
    ok: false as const,
    code: "unavailable" as ClipErrorCode,
    bytes: 0,
    runId: null,
    usd: 0,
    actor: order[0],
  };
  return !out.ok && totalUsd !== out.usd ? { ...out, usd: totalUsd } : out;
}
