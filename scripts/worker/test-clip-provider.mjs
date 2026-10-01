/**
 * Probe utils/youtube-link on five public videos.
 *   APIFY_TOKEN=... node scripts/worker/test-clip-provider.mjs
 * Prints success, wall time, file size, format, bitrate, and USD. Does not
 * log the token. A section is 20 seconds so this does not pull a whole talk.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const TOKEN = process.env.APIFY_TOKEN?.trim();
const API = "https://api.apify.com/v2";
const ACTOR = "utils~youtube-link";
const CAP = 8 * 1024 * 1024;
const WALL_MS = 45_000;

const CASES = [
  { label: "3-minute talk", id: "V74AxCqOTvg", start: 15 },
  { label: "long lecture", id: "HtSuA80QTyo", start: 90 },
  { label: "music video", id: "dQw4w9WgXcQ", start: 30 },
  { label: "age-gated", id: "eJO5HU_7_1w", start: 30 },
  { label: "region-blocked", id: "9bZkp7q19f0", start: 30 },
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
    format: "",
    bitrate: "",
    usd: 0,
    runId: "",
    note: "",
  };
  try {
    const deadline = started + WALL_MS;
    const startedRun = await fetch(`${API}/acts/${ACTOR}/runs`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        url: `https://www.youtube.com/watch?v=${item.id}`,
        audioQuality: "best",
        timeframe,
      }),
      signal: AbortSignal.timeout(WALL_MS),
    });
    if (!startedRun.ok) {
      report.note = `start ${startedRun.status}`;
      return report;
    }
    let run = (await startedRun.json()).data ?? {};
    report.runId = run.id || "";
    report.usd = Number(run.usageTotalUsd || 0);
    while (run.status === "READY" || run.status === "RUNNING") {
      if (Date.now() >= deadline) {
        report.note = "timeout";
        return report;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const polled = await fetch(`${API}/actor-runs/${run.id}`, {
        headers: headers(),
        signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
      });
      run = (await polled.json()).data ?? run;
      report.usd = Number(run.usageTotalUsd ?? report.usd);
    }
    if (run.status !== "SUCCEEDED") {
      report.note = run.status || "failed";
      return report;
    }
    const items = await fetch(`${API}/datasets/${run.defaultDatasetId}/items`, {
      headers: headers(),
      signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
    }).then((res) => res.json());
    const row = (items || []).find((entry) => entry.downloadUrl);
    if (!row) {
      report.note = "no file";
      return report;
    }
    const audio = await fetch(row.downloadUrl, {
      headers: headers(),
      signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
    });
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
    report.ok = true;
    report.bytes = buf.length;
    report.format = ext;
    const probe = spawnSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=bit_rate", "-of", "default=nw=1:nk=1", file],
      { encoding: "utf8" }
    );
    report.bitrate = probe.status === 0 ? probe.stdout.trim() : "";
    return report;
  } catch (err) {
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
    `${result.bytes}B`,
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
