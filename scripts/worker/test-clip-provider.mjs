/**
 * Probe utils/youtube-link on five public videos.
 *   APIFY_TOKEN=... node scripts/worker/test-clip-provider.mjs
 * Prints success, wall time, file size, probed duration, format, bitrate,
 * and USD. Does not log the token. A section is 20 seconds.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const TOKEN = process.env.APIFY_TOKEN?.trim();
const API = "https://api.apify.com/v2";
const ACTOR = "utils~youtube-link";
const CAP = 8 * 1024 * 1024;
const WALL_MS = 90_000;
const MAX_USD = 0.05;

const CASES = [
  { label: "3-minute talk", id: "V74AxCqOTvg", start: 15 },
  { label: "long lecture", id: "HtSuA80QTyo", start: 90 },
  { label: "music video", id: "dQw4w9WgXcQ", start: 30 },
  { label: "age-gated", id: "HtVdAasjOgU", start: 30 },
  { label: "region-blocked", id: "_PL2HJKxnOM", start: 30 },
];

function clock(seconds) {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const secs = String(whole % 60).padStart(2, "0");
  return `${minutes}:${secs}`;
}

function headers() {
  return { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
}

function scrub(text) {
  return String(text || "").split(TOKEN).join("[token]").slice(0, 180);
}

/** usageTotalUsd is 0 until the run settles. Events: $0.015 + $0.004 per 10-minute block. */
function usdFromRun(run) {
  const direct = Number(run?.usageTotalUsd || 0);
  if (direct > 0) return direct;
  const counts = run?.chargedEventCounts || {};
  let usd = 0;
  for (const [name, raw] of Object.entries(counts)) {
    const n = Number(raw) || 0;
    if (n <= 0) continue;
    if (/AUDIO_LONG_EXTRA|10.?min/i.test(name)) usd += n * 0.004;
    else if (/AUDIO_DOWNLOADED/i.test(name)) usd += n * 0.015;
  }
  return usd;
}

async function abort(runId) {
  if (!runId) return;
  await fetch(`${API}/actor-runs/${runId}/abort`, {
    method: "POST",
    headers: headers(),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {});
}

async function settleUsd(runId, usd) {
  let next = usd;
  for (const delay of [0, 1_000, 1_500]) {
    if (next > 0) break;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const billed = await fetch(`${API}/actor-runs/${runId}`, {
      headers: headers(),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    if (!billed?.ok) break;
    const run = (await billed.json()).data ?? {};
    const read = usdFromRun(run);
    if (read > 0) next = read;
  }
  return next;
}

function probeFile(file) {
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration,bit_rate", "-of", "json", file],
    { encoding: "utf8" }
  );
  if (probe.status !== 0) return { duration: "", bitrate: "" };
  try {
    const format = JSON.parse(probe.stdout).format ?? {};
    return {
      duration: format.duration ? String(Math.round(Number(format.duration) * 10) / 10) : "",
      bitrate: format.bit_rate ? String(format.bit_rate) : "",
    };
  } catch {
    return { duration: "", bitrate: "" };
  }
}

async function one(item) {
  const started = Date.now();
  const dir = await mkdtemp(path.join(tmpdir(), "apify-probe-"));
  const timeframe = `${clock(item.start)}-${clock(item.start + 20)}`;
  const report = {
    label: item.label,
    id: item.id,
    ok: false,
    ms: 0,
    bytes: 0,
    duration: "",
    format: "",
    bitrate: "",
    usd: 0,
    runId: "",
    note: "",
  };
  try {
    const deadline = started + WALL_MS;
    const startUrl = new URL(`${API}/acts/${ACTOR}/runs`);
    startUrl.searchParams.set("maxTotalChargeUsd", String(MAX_USD));
    startUrl.searchParams.set("timeout", "90");
    startUrl.searchParams.set("waitForFinish", "60");
    const startedRun = await fetch(startUrl, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        videos: [
          {
            url: `https://www.youtube.com/watch?v=${item.id}`,
            timeframe,
            audioQuality: "best",
          },
        ],
      }),
      signal: AbortSignal.timeout(WALL_MS),
    });
    if (!startedRun.ok) {
      report.note = scrub(`start ${startedRun.status} ${await startedRun.text().catch(() => "")}`);
      return report;
    }
    let run = (await startedRun.json()).data ?? {};
    report.runId = run.id || "";
    report.usd = usdFromRun(run);
    while (run.status === "READY" || run.status === "RUNNING") {
      const remain = deadline - Date.now();
      if (remain < 1500) {
        await abort(report.runId);
        report.note = "timeout";
        return report;
      }
      const wait = Math.min(60, Math.floor(remain / 1000));
      const polled = await fetch(`${API}/actor-runs/${run.id}?waitForFinish=${wait}`, {
        headers: headers(),
        signal: AbortSignal.timeout(Math.max(1000, remain)),
      });
      run = (await polled.json()).data ?? run;
      report.usd = usdFromRun(run) || report.usd;
    }
    report.waitMs = Date.now() - started;
    const items = run.defaultDatasetId
      ? await fetch(`${API}/datasets/${run.defaultDatasetId}/items`, {
          headers: headers(),
          signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
        })
          .then((res) => res.json())
          .catch(() => [])
      : [];
    const row = (items || []).find((entry) => entry.downloadUrl) ?? items?.[0];
    if (run.status !== "SUCCEEDED" || !row?.downloadUrl) {
      report.note = scrub(row?.error || run.statusMessage || run.status || "failed");
      return report;
    }
    const dl0 = Date.now();
    const audioPromise = fetch(row.downloadUrl, {
      headers: headers(),
      signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
    });
    const billPromise =
      report.usd > 0 ? Promise.resolve(report.usd) : settleUsd(report.runId, report.usd);
    const [audio, usd] = await Promise.all([audioPromise, billPromise]);
    report.usd = usd;
    report.downloadMs = Date.now() - dl0;
    const declared = Number(audio.headers.get("content-length") || 0);
    if (declared > CAP) {
      report.note = "too_big";
      report.bytes = declared;
      return report;
    }
    const buf = Buffer.from(await audio.arrayBuffer());
    if (buf.length > CAP) {
      report.note = "too_big";
      report.bytes = buf.length;
      return report;
    }
    const ext = (row.filename || "audio.m4a").split(".").pop() || "m4a";
    const file = path.join(dir, `audio.${ext}`);
    await writeFile(file, buf);
    const probed = probeFile(file);
    report.ok = true;
    report.bytes = buf.length;
    report.format = ext;
    report.duration = probed.duration;
    report.bitrate = probed.bitrate;
    return report;
  } catch (err) {
    await abort(report.runId);
    report.note = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "error";
    return report;
  } finally {
    report.ms = Date.now() - started;
    await rm(dir, { recursive: true, force: true });
  }
}

if (!TOKEN) {
  console.error("Set APIFY_TOKEN to run this probe. The token is not printed.");
  process.exit(1);
}

const lines = [];
for (const item of CASES) {
  const result = await one(item);
  const line = [
    result.ok ? "ok" : "fail",
    result.label,
    result.id,
    `${result.ms}ms`,
    result.waitMs != null ? `wait=${result.waitMs}` : "wait=-",
    result.downloadMs != null ? `dl=${result.downloadMs}` : "dl=-",
    `${result.bytes}B`,
    result.duration ? `${result.duration}s` : "-",
    result.format || "-",
    result.bitrate ? `${result.bitrate}bps` : "-",
    `$${result.usd}`,
    result.runId || "-",
    result.note || "-",
  ].join("\t");
  lines.push(line);
  console.log(line);
}
const out = path.join(tmpdir(), "test-clip-provider.last.txt");
await writeFile(out, `${lines.join("\n")}\n`);
console.log(`wrote ${out}`);
