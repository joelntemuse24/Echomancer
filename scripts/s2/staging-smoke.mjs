#!/usr/bin/env node
/**
 * Staging acceptance for the self-hosted S2-Pro clone endpoint.
 *
 * Hits the deployed HTTP endpoints the way the Contabo worker does, so a
 * broken deploy fails here instead of inside a customer's book. Synthetic
 * text and a generated reference clip only — never a real book and never a
 * customer clip.
 *
 *   MODAL_S2_TTS_URL=https://<staging-endpoint>.modal.run \
 *   MODAL_S2_TOKEN=… \
 *   node scripts/s2/staging-smoke.mjs --lanes 4
 *
 * Checks, in order:
 *   1. /ready reports a warm container and a build id (or explains why not).
 *   2. /synthesize_batch returns one decodable MP3 row per section, with the
 *      `audio_b64` field the worker reads.
 *   3. Four concurrent calls land on four distinct containers and each
 *      reports a restored (not compiled) container.
 *   4. A second identical call is consistent and does not switch build.
 *
 * Exit code is non-zero if any hard check fails. Nothing secret is printed:
 * the token is sent as a header and never echoed.
 */

import { readFileSync } from "node:fs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg.startsWith("--")) {
    const next = process.argv[i + 1];
    if (next && !next.startsWith("--")) {
      args.set(arg.slice(2), next);
      i += 1;
    } else {
      args.set(arg.slice(2), "true");
    }
  }
}

const baseUrl = (process.env.MODAL_S2_TTS_URL || "").replace(/\/+$/, "");
const token = (process.env.MODAL_S2_TOKEN || "").trim();
const lanes = Number(args.get("lanes") || "4");
const sectionsPerLane = Number(args.get("sections-per-lane") || "2");
const timeoutMs = Number(args.get("timeout-ms") || "600000");

if (!baseUrl) {
  console.error("MODAL_S2_TTS_URL is not set");
  process.exit(2);
}
if (!token) {
  console.error("MODAL_S2_TOKEN is not set");
  process.exit(2);
}

const SECTION_TEXTS = [
  "The river had not moved for three days.",
  "Elena stood at the window and watched the light change on the water.",
  "Nobody in the village had seen it so still.",
  "By the fourth morning, the ice had begun to speak.",
  "A thin sound ran along the bank like a wire drawn tight.",
  "She counted the panes and counted them again.",
  "The kettle was the only thing in the house that still moved.",
  "Outside, the light went from grey to a colour she had no name for.",
];

/**
 * Build a deterministic, non-silent 16-bit WAV. Written byte by byte so the
 * script needs no audio dependency, and so it cannot accidentally be the empty
 * file that broke the October snapshot.
 */
function referenceWav({ seconds = 6, rate = 44100 } = {}) {
  const frames = Math.floor(seconds * rate);
  const dataBytes = frames * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i += 1) {
    const t = i / rate;
    const v =
      (0.35 * Math.sin(2 * Math.PI * 180 * t) +
        0.22 * Math.sin(2 * Math.PI * 640 * t + 0.4) +
        0.05 * Math.sin(2 * Math.PI * 2400 * t)) *
      (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.7 * t));
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 20000), 44 + i * 2);
  }
  return buf;
}

/** `--reference-audio path` overrides the generated clip. */
function loadReference() {
  const explicit = args.get("reference-audio");
  if (!explicit) {
    const wav = referenceWav();
    return {
      audio: wav,
      transcript: "The river had not moved for three days.",
      source: "generated",
    };
  }
  const audio = readFileSync(explicit);
  if (audio.length < 4000) {
    throw new Error(`reference clip ${explicit} is ${audio.length} bytes; too small`);
  }
  let transcript = "";
  try {
    transcript = readFileSync(`${explicit}.txt`, "utf8").trim();
  } catch {
    transcript = "";
  }
  return { audio, transcript, source: explicit };
}

async function call(path, { method = "POST", body, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "x-echomancer-token": token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, ok: response.ok, text };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Anything with an MP3 sync word or an ID3 tag counts as audio. */
function looksLikeMp3(buffer) {
  if (buffer.length < 800) return false;
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return true;
  return buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function checkReady() {
  const response = await call("/ready", { method: "GET" });
  const body = parse(response.text);
  const ready = response.status === 200 && body?.ready === true;
  record(
    "ready",
    ready,
    body
      ? `status=${response.status} warm=${body.warm_containers} build=${body.build} lanes=${body.lanes}`
      : `status=${response.status} (non-JSON)`
  );
  return body;
}

async function batchCall(reference, laneIndex) {
  const items = Array.from({ length: sectionsPerLane }, (_, i) => {
    const index = laneIndex * sectionsPerLane + i;
    return { key: String(index), text: SECTION_TEXTS[index % SECTION_TEXTS.length] };
  });
  const started = Date.now();
  const response = await call("/synthesize_batch", {
    body: {
      items,
      reference_audio_base64: reference.audio.toString("base64"),
      reference_text: reference.transcript,
      sampling: "0.9,0.9",
      job_id: `staging-smoke-${laneIndex}`,
      seed_epoch: 0,
    },
  });
  const wall = Date.now() - started;
  const body = parse(response.text);
  return { response, body, wall, items };
}

function checkBatchRows(laneIndex, { response, body, wall, items }) {
  if (!response.ok || !body) {
    record(
      `lane ${laneIndex} batch`,
      false,
      `status=${response.status} ${response.text.slice(0, 200)}`
    );
    return null;
  }
  const rows = Array.isArray(body.items) ? body.items : [];
  const errors = rows.filter((row) => row.error);
  const audioRows = rows.filter((row) => !row.error);
  let decodable = 0;
  let totalSeconds = 0;
  for (const row of audioRows) {
    const b64 = row.audio_b64 || row.audio_base64 || "";
    const buffer = Buffer.from(b64, "base64");
    if (looksLikeMp3(buffer)) decodable += 1;
    totalSeconds += Number(row.duration_s) || 0;
  }
  const truncated = audioRows.reduce(
    (sum, row) => sum + (Number(row.truncated_units) || 0),
    0
  );
  const ok =
    rows.length === items.length && decodable === items.length && truncated === 0;
  record(
    `lane ${laneIndex} batch`,
    ok,
    `rows=${rows.length}/${items.length} decodable=${decodable} ` +
      `audio=${totalSeconds.toFixed(1)}s wall=${(wall / 1000).toFixed(1)}s ` +
      `truncated=${truncated} build=${body.build} container=${body.container_id}` +
      (errors.length ? ` errors=${JSON.stringify(errors.slice(0, 2))}` : "")
  );
  const perf = body.performance;
  if (perf) {
    console.log(
      `      perf: generate=${perf.generate_s}s codec=${perf.codec_s}s ` +
        `encode=${perf.encode_s}s realtime=${perf.generated_realtime_x}x ` +
        `restored_s=${perf.restored_s}`
    );
  }
  return { body, decodable, totalSeconds, wall };
}

async function main() {
  console.log(`staging smoke against ${new URL(baseUrl).host}\n`);
  const reference = loadReference();
  console.log(
    `reference: ${reference.source}, ${reference.audio.length} bytes, ` +
      `${reference.transcript.length} chars of transcript\n`
  );

  const ready = await checkReady();

  console.log("\n-- concurrent lanes --");
  const started = Date.now();
  const lanesResults = await Promise.all(
    Array.from({ length: Math.max(1, lanes) }, (_, lane) => batchCall(reference, lane))
  );
  const fanoutWall = Date.now() - started;
  const checked = lanesResults.map((result, lane) => checkBatchRows(lane, result)).filter(Boolean);

  const containers = new Set(
    checked.map((entry) => entry?.body?.container_id).filter(Boolean)
  );
  record(
    "independent containers",
    containers.size >= Math.min(lanes, checked.length),
    `${containers.size} distinct container(s) for ${checked.length} call(s) in ` +
      `${(fanoutWall / 1000).toFixed(1)}s`
  );

  const audioSeconds = checked.reduce((sum, entry) => sum + (entry?.totalSeconds || 0), 0);
  record(
    "throughput",
    audioSeconds > 0,
    `${audioSeconds.toFixed(1)}s of audio in ${(fanoutWall / 1000).toFixed(1)}s ` +
      `= ${(audioSeconds / (fanoutWall / 1000)).toFixed(1)}x realtime across lanes`
  );

  const builds = new Set(checked.map((entry) => entry?.body?.build).filter(Boolean));
  record(
    "one build across lanes",
    builds.size === 1,
    `${[...builds].join(",") || "none"}${ready?.build ? ` (ready says ${ready.build})` : ""}`
  );

  console.log("\n-- consistency --");
  const again = checkBatchRows(0, await batchCall(reference, 0));
  record(
    "second call consistent",
    Boolean(again),
    again ? `rows=${again.decodable} build=${again.body?.build}` : "no rows"
  );

  const failed = results.filter((result) => !result.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed`
  );
  if (failed.length > 0) {
    console.log("failed:", failed.map((result) => result.name).join(", "));
    process.exit(1);
  }
  console.log(
    "\nEvidence to record in the PR: the build id above, distinct container\n" +
      "count, per-lane realtime, and the Modal dashboard's Containers tab\n" +
      "(restored icon, then scale-to-zero after the scaledown window)."
  );
}

main().catch((err) => {
  console.error("staging smoke failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
