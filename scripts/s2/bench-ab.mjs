#!/usr/bin/env node
/**
 * Matched before/after timing for the clone GPU path.
 *
 * Two runs of this script, one per deployed build, are the evidence a speedup
 * claim needs: same text, same reference clip, same seed, same widths. Anything
 * else compares two different jobs and calls the difference an improvement.
 *
 *   # while staging is warm, on build A
 *   MODAL_S2_TTS_URL=… MODAL_S2_TOKEN=… \
 *     node scripts/s2/bench-ab.mjs --record /tmp/s2-ab/before
 *
 *   # after deploying build B to the same staging app
 *   MODAL_S2_TTS_URL=… MODAL_S2_TOKEN=… \
 *     node scripts/s2/bench-ab.mjs --record /tmp/s2-ab/after
 *
 *   npx tsx scripts/s2/qa-compare.ts /tmp/s2-ab/before /tmp/s2-ab/after
 *
 * What a run records, per workload:
 *   - wall milliseconds and the server's own `performance` breakdown
 *   - every section's MP3 (inline base64, or read back from R2), so QA can
 *     compare the audio itself rather than trusting a duration
 *   - per-row `duration_s`, `units`, `unit_shape`, `truncated_units`
 *   - the build id, `boot`, and container id each call came from
 *
 * The corpus is **synthetic and deterministic**: fixed public-domain text,
 * fixed seed, and a reference clip that is either generated here or a file you
 * pass. Never a customer clip, and never a real book.
 *
 * Costs H100 time. Nothing here runs automatically.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { join } from "node:path";

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

const recordDir = args.get("record");
if (!recordDir) {
  console.error(
    "usage: node scripts/s2/bench-ab.mjs --record <dir>\n" +
      "  env:   MODAL_S2_TTS_URL (required), MODAL_S2_READY_URL, MODAL_S2_TOKEN\n" +
      "         R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY /\n" +
      "         R2_BUCKET_NAME — only to read back an r2 page's objects\n" +
      "  flags: --reference-audio <path>  --workloads 1,4,24,32  --timeout-ms N"
  );
  process.exit(2);
}

function normalizeEndpoint(raw, label, required = false) {
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
  if (url.pathname.replace(/\/+$/, "")) {
    console.error(
      `${label} must be a bare Modal endpoint host: each @modal.fastapi_endpoint ` +
        "is served at its own hostname root, so a path is a 404."
    );
    process.exit(2);
  }
  return url.origin;
}

const batchUrl = normalizeEndpoint(process.env.MODAL_S2_TTS_URL, "MODAL_S2_TTS_URL", true);
const readyUrl = normalizeEndpoint(process.env.MODAL_S2_READY_URL, "MODAL_S2_READY_URL");
const token = (process.env.MODAL_S2_TOKEN || "").trim();
if (!token) {
  console.error("MODAL_S2_TOKEN is not set");
  process.exit(2);
}
const timeoutMs = Number(args.get("timeout-ms") || "900000");

// ── the corpus ─────────────────────────────────────────────────────────────
//
// Public-domain prose in fixed paragraph units, so two runs send the same
// characters and the same unit boundaries. Assembled by repetition rather than
// shipped as a data file: the point is that it is identical between runs.

const PARAGRAPHS = [
  "It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.",
  "However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered as the rightful property of some one or other of their daughters.",
  "\"My dear Mr. Bennet,\" said his lady to him one day, \"have you heard that Netherfield Park is let at last?\"",
  "Mr. Bennet replied that he had not.",
  "\"But it is,\" returned she; \"for Mrs. Long has just been here, and she told me all about it.\"",
  "Mr. Bennet made no answer.",
  "\"Do you not want to know who has taken it?\" cried his wife impatiently.",
  "\"You want to tell me, and I have no objection to hearing it.\"",
  "This was invitation enough.",
  "\"Why, my dear, you must know, Mrs. Long says that Netherfield is taken by a young man of large fortune from the north of England; that he came down on Monday in a chaise and four to see the place, and was so much delighted with it, that he agreed with Mr. Morris immediately; that he is to take possession before Michaelmas, and some of his servants are to be in the house by the end of next week.\"",
];

/** `chars` characters of prose, cut at a word boundary. */
function corpus(chars) {
  const out = [];
  let total = 0;
  let i = 0;
  while (total < chars) {
    const paragraph = PARAGRAPHS[i % PARAGRAPHS.length];
    out.push(paragraph);
    total += paragraph.length + 2;
    i += 1;
  }
  return out.join("\n\n").slice(0, chars);
}

/**
 * The four workloads, matching the shapes staging measures.
 *
 * `24` is the baseline geometry (43,907 characters over 24 sections), so the
 * recorded wall is directly comparable to the 83.18 s / 33.0x figure the plan
 * starts from. `32` runs only when `/ready` says the container accepts 32 rows
 * and returns keys.
 */
const WORKLOADS = {
  1: { rows: 1, totalChars: 1_000, label: "1-wide (opening section)" },
  4: { rows: 4, totalChars: 10_400, label: "4-wide (short book)" },
  24: { rows: 24, totalChars: 43_907, label: "24-wide (baseline geometry)" },
  32: { rows: 32, totalChars: 58_500, label: "32-wide (full R2 page)" },
};

/** Cut `text` into `n` chunks near paragraph ends. Deterministic. */
function splitInto(text, n) {
  const chunks = [];
  let start = 0;
  for (let i = 0; i < n && start < text.length; i += 1) {
    const left = n - i;
    let end = Math.min(text.length, start + Math.ceil((text.length - start) / left));
    if (i < n - 1 && end < text.length) {
      const nextBreak = text.indexOf("\n\n", end);
      if (nextBreak !== -1) end = nextBreak;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    start = end + 2;
  }
  return chunks;
}

// ── the reference clip ─────────────────────────────────────────────────────

/**
 * A deterministic, speech-shaped WAV.
 *
 * Deliberately **not** the 6 s sine probe the boot self-test uses. The speaker
 * encoder needs at least four 4 s windows and S2-Pro builds a real ~400-token
 * prompt from the clip, so a pure tone would make WER and similarity
 * meaningless.
 *
 * Still only a stand-in. For the similarity and WER numbers to mean anything,
 * pass `--reference-audio` with a 16–20 s public-domain reading and its `.txt`
 * transcript beside it. Without one the timing numbers are valid and the
 * quality numbers are not.
 */
function placeholderWav({ seconds = 18, rate = 44100 } = {}) {
  const frames = Math.floor(seconds * rate);
  const data = frames * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + data, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(data, 40);
  // Amplitude-modulated harmonics: speech-shaped, and deterministic so both
  // runs send byte-identical audio.
  for (let i = 0; i < frames; i += 1) {
    const t = i / rate;
    const syllable = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3.4 * t);
    const v =
      (0.30 * Math.sin(2 * Math.PI * 132 * t) +
        0.20 * Math.sin(2 * Math.PI * 396 * t + 0.5) +
        0.10 * Math.sin(2 * Math.PI * 1180 * t + 1.1) +
        0.04 * Math.sin(2 * Math.PI * 2600 * t + 2.0)) *
      syllable;
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 22000), 44 + i * 2);
  }
  return buf;
}

function loadReference() {
  const path = args.get("reference-audio");
  if (!path) {
    return {
      audio: placeholderWav(),
      transcript: "convert the provided text to speech",
      source: "placeholder-tone",
      speechLike: false,
    };
  }
  const audio = readFileSync(path);
  if (audio.length < 4000) throw new Error(`${path} is ${audio.length} bytes; too small`);
  let transcript = "";
  try {
    transcript = readFileSync(`${path}.txt`, "utf8").trim();
  } catch {
    transcript = "";
  }
  return { audio, transcript, source: path, speechLike: true };
}

// ── R2 read-back (SigV4, no dependency) ────────────────────────────────────

function r2Credentials() {
  const account = (process.env.R2_ACCOUNT_ID || "").trim();
  const access = (process.env.R2_ACCESS_KEY_ID || "").trim();
  const secret = (process.env.R2_SECRET_ACCESS_KEY || "").trim();
  const bucket = (process.env.R2_BUCKET_NAME || "").trim() || "echomancer-audio";
  if (!account || !access || !secret) return null;
  return { account, access, secret, bucket };
}

/** A signed R2 request. Mirrors `modal/s2_audio_store.py`; prints no secrets. */
function signR2(method, key) {
  const creds = r2Credentials();
  if (!creds) return null;
  const moment = new Date();
  const amzDate = moment.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const host = `${creds.account}.r2.cloudflarestorage.com`;
  const canonicalUri =
    "/" + creds.bucket + "/" + key.split("/").map(encodeURIComponent).join("/");
  const payloadHash = createHash("sha256").update("").digest("hex");
  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
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

const TAKE_KEY = /^s2-takes\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.mp3$/;

async function readTake(key) {
  if (!TAKE_KEY.test(key)) return null;
  const signed = signR2("GET", key);
  if (!signed) return { storageKey: key, deferred: "no R2 credentials on this host" };
  const response = await fetch(signed.url, { headers: signed.headers });
  if (!response.ok) {
    return { storageKey: key, deferred: `R2 GET ${response.status}` };
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Best effort: leave nothing behind under `s2-takes/` after a benchmark. */
async function deleteTake(key) {
  if (!TAKE_KEY.test(key)) return;
  const signed = signR2("DELETE", key);
  if (!signed) return;
  await fetch(signed.url, { method: "DELETE", headers: signed.headers }).catch(
    () => undefined
  );
}

/**
 * Does this file decode as audio?
 *
 * A magic-byte check would reject a perfectly good take that happens to start
 * with a different container, and would accept a truncated MP3 whose header
 * survived. `ffprobe` answering with a duration is the property that matters:
 * the worker's next stage has to decode it.
 */
function decodable(path) {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
    { encoding: "utf8" }
  );
  if (result.status !== 0) return null;
  const seconds = Number(String(result.stdout).trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** Cheap pre-check so a 0-byte row fails before it reaches ffprobe. */
function looksLikeAudio(buffer) {
  if (!buffer || buffer.length < 800) return false;
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return true; // ID3
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return true; // MP3 frame
  return (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
  ); // RIFF/WAV
}

// ── transport ──────────────────────────────────────────────────────────────

async function call(url, { method = "POST", body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "x-echomancer-token": token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function probeReady() {
  if (!readyUrl) return null;
  try {
    const response = await call(readyUrl, { method: "GET" });
    return { status: response.status, body: safeJson(await response.text()) };
  } catch (err) {
    return { status: 0, body: null, error: String(err) };
  }
}

// ── one workload ───────────────────────────────────────────────────────────

async function takeBytes(row) {
  const b64 = row.audio_b64 || row.audio_base64 || "";
  if (b64) return Buffer.from(b64, "base64");
  const key = typeof row.storage_key === "string" ? row.storage_key.trim() : "";
  if (!key) return null;
  return readTake(key);
}

async function runWorkload(name, spec, reference, ready) {
  const text = corpus(spec.totalChars);
  const sections = splitInto(text, spec.rows);
  const items = sections.map((section, index) => ({ key: String(index), text: section }));
  const largest = Math.max(...sections.map((section) => section.length));
  console.log(
    `\n-- ${spec.label}: ${items.length} rows, ${text.length} chars (largest ${largest}) --`
  );

  // ---- the wall clock -----------------------------------------------------
  //
  // `wallMs` is what the A/B compares, so it has to mean the same thing on both
  // builds: **time until every section's audio is in this process's memory**.
  //
  // `fetch()` resolves when the response *headers* arrive, so a clock stopped
  // there omits the body. On the inline build that body is the whole 58 MB of
  // base64 — about 12 s, which silently inflated the 33x baseline to ~38.5x. On
  // the r2 build the body is a few kilobytes of keys and the audio arrives as
  // 24–32 separate object reads instead, so the omission went the other way.
  // Neither is the pipeline's real wall time.
  //
  // The three parts are reported separately as well, so a reader can see which
  // stage a difference came from instead of inferring it from one number.
  const started = Date.now();
  const response = await call(batchUrl, {
    body: {
      items,
      reference_audio_base64: reference.audio.toString("base64"),
      reference_text: reference.transcript,
      sampling: "0.9,0.9",
      job_id: `bench-${name}`,
      seed_epoch: 0,
    },
  });
  const headersMs = Date.now() - started;
  const raw = await response.text();
  const bodyMs = Date.now() - started - headersMs;
  if (!response.ok) {
    console.error(`  FAIL status=${response.status} ${raw.slice(0, 400)}`);
    return { name, ok: false, status: response.status, error: raw.slice(0, 400) };
  }
  const body = safeJson(raw);
  if (!body) {
    console.error("  FAIL non-JSON body");
    return { name, ok: false, error: "non-json" };
  }

  const outDir = join(recordDir, name);
  mkdirSync(outDir, { recursive: true });
  const rows = [];
  const deferred = [];
  const keysToDelete = [];
  const r2Started = Date.now();
  // Read every section's audio into RAM with bounded 8-way concurrency, matching
  // `MODAL_CLONE_AUDIO_READ_CONCURRENCY` on the worker. Stop `r2ReadMs` and
  // `wallMs` as soon as all audio Buffers are in memory: local disk writes,
  // `ffprobe` validation, and R2 `DELETE` cleanup (which the worker schedules
  // asynchronously off the critical path) must not inflate either build's clock.
  const validRows = (body.items ?? []).filter((row) => !row.error);
  const prefetched = new Map();
  const READ_CONCURRENCY = 8;
  for (let i = 0; i < validRows.length; i += READ_CONCURRENCY) {
    const slice = validRows.slice(i, i + READ_CONCURRENCY);
    await Promise.all(
      slice.map(async (row) => {
        prefetched.set(row.key, await takeBytes(row));
      })
    );
  }
  const r2ReadMs = Date.now() - r2Started;
  // The clock the A/B uses: headers + body + every audio read, i.e. everything
  // between "post" and "all audio in RAM".
  const wallMs = Date.now() - started;

  for (const row of body.items ?? []) {
    if (row.error) {
      rows.push({ key: row.key, error: row.error, error_code: row.error_code });
      continue;
    }
    const bytes = prefetched.get(row.key) ?? null;
    if (Buffer.isBuffer(bytes)) {
      const file = `${row.key}.mp3`;
      writeFileSync(join(outDir, file), bytes);
      if (!looksLikeAudio(bytes)) {
        console.error(`  FAIL row ${row.key} is not audio (${bytes.length} bytes)`);
      } else if (decodable(join(outDir, file)) == null) {
        console.error(`  FAIL row ${row.key} does not decode`);
      }
      if (typeof row.storage_key === "string") keysToDelete.push(row.storage_key);
    } else if (bytes && bytes.storageKey) {
      deferred.push({ key: row.key, reason: bytes.deferred, storageKey: bytes.storageKey });
      keysToDelete.push(bytes.storageKey);
    }
    rows.push({
      key: row.key,
      // The text this section was rendered from. QA needs it to compute a real
      // word error rate; comparing two transcripts only proves the two runs
      // agree with each other, not that either says the right words.
      text: items.find((item) => item.key === row.key)?.text ?? null,
      file: Buffer.isBuffer(bytes) ? `${row.key}.mp3` : null,
      bytes: Buffer.isBuffer(bytes) ? bytes.length : 0,
      deferred_read: Buffer.isBuffer(bytes) ? null : (bytes?.deferred ?? "no audio"),
      storage_key: row.storage_key ?? null,
      duration_s: row.duration_s,
      units: row.units,
      unit_shape: row.unit_shape,
      truncated_units: row.truncated_units,
    });
  }
  // Sweep all `s2-takes/` objects concurrently after timing has stopped so
  // staging leaves nothing behind and warm-container idle gap stays tiny.
  for (let i = 0; i < keysToDelete.length; i += READ_CONCURRENCY) {
    const slice = keysToDelete.slice(i, i + READ_CONCURRENCY);
    await Promise.all(slice.map((key) => deleteTake(key)));
  }

  const audioSeconds = rows.reduce((sum, row) => sum + (Number(row.duration_s) || 0), 0);
  const realtime = wallMs > 0 ? audioSeconds / (wallMs / 1000) : 0;
  const perf = body.performance ?? null;
  console.log(
    `  rows=${rows.length}/${items.length} audio=${audioSeconds.toFixed(1)}s ` +
      `wall=${(wallMs / 1000).toFixed(2)}s = ${realtime.toFixed(1)}x realtime`
  );
  console.log(
    `  wall split: headers=${headersMs}ms body=${bodyMs}ms ` +
      `audio_read=${r2ReadMs}ms`
  );
  if (perf) {
    console.log(
      `  perf: prepare=${perf.prepare_s}s generate=${perf.generate_s}s ` +
        `codec=${perf.codec_s}s encode=${perf.encode_s}s call=${perf.call_s}s ` +
        `width=${perf.batch_width ?? "?"} pipeline=${perf.pipeline ?? "?"} ` +
        `codec_inline=${perf.codec_inline_s ?? "?"}s codec_tail=${perf.codec_tail_s ?? "?"}s ` +
        `streamed=${perf.sections_streamed ?? "?"} upload=${perf.upload_transport ?? "?"}`
    );
  }
  if (deferred.length) {
    console.log(
      `  ${deferred.length} r2 object(s) NOT read back (${deferred[0].reason}); ` +
        "set R2_* on this host for QA to compare this run's audio"
    );
  }

  return {
    name,
    ok: true,
    label: spec.label,
    rows: items.length,
    chars: text.length,
    largestRowChars: largest,
    wallMs,
    headersMs,
    bodyMs,
    r2ReadMs,
    audioSeconds,
    realtime,
    httpBytes: Buffer.byteLength(raw),
    build: body.build ?? null,
    containerId: body.container_id ?? null,
    boot: body.boot ?? null,
    seed: body.seed ?? null,
    sampling: body.sampling ?? null,
    reference: body.reference ?? null,
    performance: perf,
    sections: rows,
    ready: ready
      ? {
          status: ready.status,
          transport: ready.body?.audio_transport ?? null,
          maxBatchItems: ready.body?.max_batch_items ?? null,
          version: ready.body?.version ?? null,
          build: ready.body?.build ?? null,
        }
      : null,
  };
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(recordDir, { recursive: true });
  const reference = loadReference();
  const ready = await probeReady();
  const transport = ready?.body?.audio_transport ?? "inline";
  const maxRows = Number(ready?.body?.max_batch_items) || 0;

  console.log(`bench against ${new URL(batchUrl).host}`);
  console.log(
    `  ready: ${ready ? `status=${ready.status}` : "not configured"}` +
      ` transport=${transport} max_rows=${maxRows || "?"}` +
      ` build=${ready?.body?.build ?? "?"} version=${ready?.body?.version ?? "?"}`
  );
  console.log(
    `  reference: ${reference.source}, ${reference.audio.length} bytes` +
      (reference.speechLike
        ? ""
        : " -- PLACEHOLDER: pass --reference-audio for a real quality check")
  );
  if (!ready || ready.status !== 200) {
    console.error(
      "\nThe pool is not warm. Warm it first (s2_clone_warm.py), or the first " +
        "workload pays a snapshot restore and the numbers are not comparable."
    );
  }

  const requested = (args.get("workloads") || "1,4,24,32")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const results = [];
  for (const name of requested) {
    const spec = WORKLOADS[Number(name)];
    if (!spec) {
      console.error(`  skipping unknown workload ${name}`);
      continue;
    }
    if (Number(name) === 32 && !(transport === "r2" && maxRows >= 32)) {
      console.log(
        `\n-- skipping 32-wide: /ready reports transport=${transport} ` +
          `max_rows=${maxRows || "?"}; a 32-row page needs r2 and 32 --`
      );
      continue;
    }
    const result = await runWorkload(name, spec, reference, ready);
    results.push(result);
    if (!result.ok) continue;
    // Back-to-back calls reuse the warm container, which is what production
    // does. Pausing here would measure a cold start instead.
    console.log("  (next call immediately, to keep the container warm)");
  }

  const manifest = {
    recorded_at: new Date().toISOString(),
    batch_host: new URL(batchUrl).host,
    reference: {
      source: reference.source,
      bytes: reference.audio.length,
      transcript_chars: reference.transcript.length,
      speech_like: reference.speechLike,
      sha256: createHash("sha256").update(reference.audio).digest("hex"),
    },
    ready: ready?.body ?? null,
    workloads: results,
  };
  const path = join(recordDir, "manifest.json");
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`\nrecorded ${results.length} workload(s) to ${path}`);
  for (const result of results) {
    if (!result.ok) {
      console.log(`  ${result.name}: FAILED (${result.error ?? result.status})`);
      continue;
    }
    console.log(
      `  ${String(result.name).padStart(2)}-wide: ${result.realtime.toFixed(1)}x ` +
        `(${(result.wallMs / 1000).toFixed(2)}s for ${result.audioSeconds.toFixed(1)}s)`
    );
  }
  if (results.some((result) => !result.ok)) process.exit(1);
}

main().catch((err) => {
  console.error("bench failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
