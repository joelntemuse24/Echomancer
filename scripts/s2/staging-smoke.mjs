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
 *   0. The S2 input queue has no PENDING or unfinished FunctionCalls
 *      (refuses to start otherwise; see the runbook's safe-draining note).
 *   1. /ready reports a warm container and a build id (or explains why not).
 *   2. POST <MODAL_S2_TTS_URL>/ returns one decodable MP3 row per section, with
 *      the `audio_b64` field the worker reads.
 *   3. Four concurrent calls land on four distinct containers and each
 *      reports a restored (not compiled) container.
 *   4. A second identical call is consistent and does not switch build.
 *
 * Endpoint shape: Modal serves each `@modal.fastapi_endpoint` at the root of
 * **its own hostname**, so there is no shared base to append paths to. This
 * script therefore takes one absolute URL per endpoint and never joins a route
 * onto one:
 *
 *   MODAL_S2_TTS_URL         the synthesize_batch host   (required)
 *   MODAL_S2_READY_URL       the ready host              (optional)
 *   MODAL_S2_SYNTHESIZE_URL  the single-section host      (optional)
 *
 * Exit code is non-zero if any hard check fails. Nothing secret is printed:
 * the token is sent as a header and never echoed.
 */

import { readFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

/**
 * Validate one endpoint URL as a bare origin.
 *
 * A trailing slash is tolerated; a path is not, because that is exactly the
 * mistake that 404s: Modal gives every endpoint its own hostname, so a path
 * means someone appended a route.
 */
function endpoint(raw, label, { required = false } = {}) {
  const text = (raw || "").trim();
  if (!text) {
    if (required) {
      console.error(`${label} is not set`);
      process.exit(2);
    }
    return null;
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    console.error(`${label} must be an absolute http(s) URL`);
    process.exit(2);
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path) {
    console.error(
      `${label} must be a bare Modal endpoint host, but it has path "${url.pathname}".\n` +
        "Modal serves each @modal.fastapi_endpoint at its own hostname root; pass the whole URL instead of appending a route."
    );
    process.exit(2);
  }
  return url.origin;
}

const batchUrl = endpoint(process.env.MODAL_S2_TTS_URL, "MODAL_S2_TTS_URL", {
  required: true,
});

function assertInputQueueEmpty() {
  if (args.get("skip-queue-check") === "true") return;
  const script = join(dirname(fileURLToPath(import.meta.url)), "check-input-queue.py");
  const result = spawnSync(process.env.PYTHON || "python3", [script], {
    encoding: "utf8",
    env: process.env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    console.error(
      "staging-smoke refused to start: the S2 input queue is not empty. " +
        "See docs/s2-gpu-staging-runbook.md (safe draining). Do not cancel " +
        "or container-stop a live compile; drain leftovers on a ready " +
        "container or pass --skip-queue-check only if you have already drained."
    );
    process.exit(result.status == null ? 2 : result.status);
  }
}

const readyUrl = endpoint(process.env.MODAL_S2_READY_URL, "MODAL_S2_READY_URL");
const singleUrl = endpoint(
  process.env.MODAL_S2_SYNTHESIZE_URL,
  "MODAL_S2_SYNTHESIZE_URL"
);
const token = (process.env.MODAL_S2_TOKEN || "").trim();
// One job id for every lane: the worker validates a take key against the job
// it asked for, so a per-lane id would not match what a real call looks like.
const SMOKE_JOB_ID = "staging-smoke";
const lanes = Number(args.get("lanes") || "4");
const sectionsPerLane = Number(args.get("sections-per-lane") || "2");
const timeoutMs = Number(args.get("timeout-ms") || "600000");

if (readyUrl && readyUrl === batchUrl) {
  console.error(
    "MODAL_S2_READY_URL points at the synthesize_batch host. The ready probe is a separate endpoint with its own hostname."
  );
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

/** One call to one endpoint origin. Never joins a route onto a base URL. */
async function call(url, { method = "POST", body, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const response = await fetch(url, {
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
  if (!readyUrl) {
    record(
      "ready",
      false,
      "MODAL_S2_READY_URL is not set — the probe is a separate endpoint host, so it cannot be derived"
    );
    return null;
  }
  const response = await call(readyUrl, { method: "GET" });
  const body = parse(response.text);
  const ready = response.status === 200 && body?.ready === true;
  record(
    "ready",
    ready,
    body
      ? `status=${response.status} warm=${body.warm_containers} build=${body.build} ` +
        `lanes=${body.lanes} transport=${body.audio_transport ?? "inline"} ` +
        `max_rows=${body.max_batch_items ?? "?"} version=${body.version ?? "?"}`
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
  const response = await call(batchUrl, {
    body: {
      items,
      reference_audio_base64: reference.audio.toString("base64"),
      reference_text: reference.transcript,
      sampling: "0.9,0.9",
      // One job id for the whole smoke, so every lane's keys share the prefix
      // a worker would check (`s2-takes/<job>/...`) and the sweep below finds
      // them all.
      job_id: SMOKE_JOB_ID,
      seed_epoch: 0,
    },
  });
  const wall = Date.now() - started;
  const body = parse(response.text);
  return { response, body, wall, items };
}

/**
 * One single-section call. This is the path staging found broken: `.remote()`
 * worked while the HTTP endpoint died with CUBLAS_STATUS_ALLOC_FAILED.
 */
async function singleCall(reference) {
  if (!singleUrl) return null;
  const started = Date.now();
  const response = await call(singleUrl, {
    body: {
      text: SECTION_TEXTS[0],
      reference_audio_base64: reference.audio.toString("base64"),
      reference_text: reference.transcript,
      sampling: "0.9,0.9",
      job_id: "staging-smoke-single",
      seed_epoch: 0,
      json: true,
    },
  });
  const wall = Date.now() - started;
  const body = parse(response.text);
  return { response, body, wall };
}

function checkSingle({ response, body, wall }) {
  const audio = body ? Buffer.from(body.audio_b64 || "", "base64") : Buffer.alloc(0);
  const ok = Boolean(
    response.ok && body && looksLikeMp3(audio) && Number(body.truncated_units) === 0
  );
  record(
    "http /synthesize after restore",
    ok,
    response.ok && body
      ? `audio=${body.duration_s}s truncated=${body.truncated_units} ` +
          `boot=${body.boot} wall=${(wall / 1000).toFixed(1)}s`
      : `status=${response.status} ${response.text.slice(0, 300)}`
  );
  return ok;
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
  const unreadable = [];
  for (const row of audioRows) {
    const buffer = rowAudioBuffer(row);
    if (looksLikeMp3(buffer)) decodable += 1;
    else if (row.storage_key) unreadable.push(row.storage_key);
    totalSeconds += Number(row.duration_s) || 0;
  }
  const truncated = audioRows.reduce(
    (sum, row) => sum + (Number(row.truncated_units) || 0),
    0
  );
  const ok =
    rows.length === items.length &&
    decodable === items.length &&
    truncated === 0 &&
    unreadable.length === 0;
  record(
    `lane ${laneIndex} batch`,
    ok,
    `rows=${rows.length}/${items.length} decodable=${decodable} ` +
      `audio=${totalSeconds.toFixed(1)}s wall=${(wall / 1000).toFixed(1)}s ` +
      `truncated=${truncated} build=${body.build} container=${body.container_id}` +
      (errors.length ? ` errors=${JSON.stringify(errors.slice(0, 2))}` : "") +
      (unreadable.length ? ` unreadable_r2=${unreadable.length}` : "")
  );
  const perf = body.performance;
  if (perf) {
    console.log(
      `      perf: generate=${perf.generate_s}s codec=${perf.codec_s}s ` +
        `encode=${perf.encode_s}s realtime=${perf.generated_realtime_x}x ` +
        `boot=${body.boot} snapshot_age=${perf.snapshot_age_s}s ` +
        `width=${perf.batch_width ?? "?"} pipeline=${perf.pipeline ?? "?"} ` +
        `codec_inline=${perf.codec_inline_s ?? "?"}s codec_tail=${perf.codec_tail_s ?? "?"}s ` +
        `upload=${perf.upload_transport ?? "?"}`
    );
  }
  return { body, decodable, totalSeconds, wall };
}

/**
 * The MP3 bytes for one row, from either transport.
 *
 * An `inline` build returns `audio_b64`. An `r2` build uploads the MP3 and
 * returns a `storage_key`, so the bytes are read from R2 with a SigV4 GET. That
 * read is what proves the object the worker will fetch actually exists and is
 * an MP3 — a smoke that only checked the key would pass on a broken upload.
 *
 * The object is deleted afterwards so staging leaves nothing behind under
 * `s2-takes/`. R2 credentials are read from the environment and never printed.
 */
function rowAudioBuffer(row) {
  const b64 = row.audio_b64 || row.audio_base64 || "";
  if (b64) return Buffer.from(b64, "base64");
  const key = typeof row.storage_key === "string" ? row.storage_key.trim() : "";
  if (!key) return Buffer.alloc(0);
  if (!/^s2-takes\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.mp3$/.test(key)) {
    return Buffer.alloc(0);
  }
  const buffer = r2Get(key);
  r2Delete(key);
  return buffer || Buffer.alloc(0);
}

/** R2 credentials for a direct object read, or null when this host has none. */
function r2Credentials() {
  const account = (process.env.R2_ACCOUNT_ID || "").trim();
  const access = (process.env.R2_ACCESS_KEY_ID || "").trim();
  const secret = (process.env.R2_SECRET_ACCESS_KEY || "").trim();
  const bucket = (process.env.R2_BUCKET_NAME || "").trim() || "echomancer-audio";
  if (!account || !access || !secret) return null;
  return { account, access, secret, bucket };
}

/**
 * SigV4 for one object request. Written out rather than imported so this script
 * stays dependency-free; the algorithms match `modal/s2_audio_store.py`, and a
 * disagreement shows up as a 403 here rather than as a mystery in a book.
 */
function sigv4(method, key, extraHeaders = {}) {
  const creds = r2Credentials();
  if (!creds) return null;
  const moment = new Date();
  const amzDate = moment.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const host = `${creds.account}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${creds.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const payloadHash = createHash("sha256").update("").digest("hex");
  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...extraHeaders,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const sign = (value, message) =>
    createHmac("sha256", value).update(message).digest();
  const signing = sign(
    sign(sign(sign(`AWS4${creds.secret}`, dateStamp), "auto"), "s3"),
    "aws4_request"
  );
  const signature = createHmac("sha256", signing).update(stringToSign).digest("hex");
  return {
    url: `https://${host}${canonicalUri}`,
    headers: {
      ...headers,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${creds.access}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

/** Blocking GET so `rowAudioBuffer` can stay synchronous. Never logs secrets. */
function r2Get(key) {
  const signed = sigv4("GET", key);
  if (!signed) {
    console.error(
      "  r2 row returned but R2_* is not set on this host; cannot verify the object"
    );
    return null;
  }
  const curl = spawnSync(
    "curl",
    ["-sS", "--fail", "-H", `Authorization: ${signed.headers.Authorization}`,
     "-H", `x-amz-content-sha256: ${signed.headers["x-amz-content-sha256"]}`,
     "-H", `x-amz-date: ${signed.headers["x-amz-date"]}`, signed.url],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  if (curl.status !== 0) {
    console.error(`  r2 GET failed for ${key.split("/").pop()}: ${curl.status}`);
    return null;
  }
  return curl.stdout;
}

/** Best-effort DELETE so staging leaves zero orphan objects under `s2-takes/`. */
function r2Delete(key) {
  const signed = sigv4("DELETE", key);
  if (!signed) return;
  spawnSync(
    "curl",
    ["-sS", "-o", "/dev/null", "-X", "DELETE",
     "-H", `Authorization: ${signed.headers.Authorization}`,
     "-H", `x-amz-content-sha256: ${signed.headers["x-amz-content-sha256"]}`,
     "-H", `x-amz-date: ${signed.headers["x-amz-date"]}`, signed.url],
    { maxBuffer: 1024 * 1024 }
  );
}

async function main() {
  assertInputQueueEmpty();
  console.log(`staging smoke against ${new URL(batchUrl).host}`);
  if (readyUrl) console.log(`  ready:        ${new URL(readyUrl).host}`);
  if (singleUrl) console.log(`  synthesize:   ${new URL(singleUrl).host}`);
  console.log("");
  const reference = loadReference();
  console.log(
    `reference: ${reference.source}, ${reference.audio.length} bytes, ` +
      `${reference.transcript.length} chars of transcript\n`
  );

  const ready = await checkReady();

  // The regression staging hit: a restore that works for `.remote()` but dies
  // on the first HTTP call with CUBLAS_STATUS_ALLOC_FAILED. Check it first and
  // on its own, so a batch failure below cannot be blamed on it.
  if (singleUrl) {
    console.log("-- http synthesize after restore --");
    checkSingle(await singleCall(reference));
  }

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

  const boots = new Set(checked.map((entry) => entry?.body?.boot).filter(Boolean));
  record(
    "every lane served by a restored container",
    boots.size === 1 && boots.has("restored"),
    `${[...boots].join(",") || "none"}`
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
      "count, per-lane realtime, `boot=restored` on the HTTP path, and the Modal\n" +
      "dashboard's Containers tab (restore icon, then scale-to-zero after the\n" +
      "scaledown window). A restore duration is only measurable from outside, so\n" +
      "time the first cold call rather than reading it off the container."
  );
}

main().catch((err) => {
  console.error("staging smoke failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
