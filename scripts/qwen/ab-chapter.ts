/**
 * Qwen 3.1 Flash A/B: one chapter page as one long call vs sentence chunks,
 * same voice and seed, scored with scripts/qwen/artifact_qa.py.
 *
 *   npx tsx scripts/qwen/ab-chapter.ts --text page.txt --voice <voice_id> \
 *     --seed 42 --out /tmp/qwen-ab/run1 [--env-file .env.qwen] [--control] \
 *     [--candidates 3] [--determinism] [--dry-run] [--fake]
 *
 * Arms (each a full rendering of the same page):
 *   single          one call with the whole page
 *   single-post     the same audio with the deline + degate repairs (no call)
 *   chunked         ~220-char sentence chunks, joined with pauses, no repairs
 *   chunked-post    the same chunk takes joined with the repairs (no call)
 *   control         --control: one call with the paragraphs in reverse order,
 *                   so position in the call and the words can be told apart
 *   chunked-best    --candidates N: N seeds per chunk, lowest harm_badness kept
 *   determinism     --determinism: chunk 0 twice with the same seed
 *
 * Writes <out>/<arm>.mp3, <out>/chunks/, runs.jsonl (one line per API call:
 * arm, chunk, chars, seed, request id, audio host, latency, attempts;
 * never the key or the signed audio link), qa.json, windows.csv (per 4 s),
 * and report.md.
 *
 * Env: DASHSCOPE_API_KEY (or QWEN_TTS_API_KEY) and DASHSCOPE_WORKSPACE_ID
 * (or DASHSCOPE_BASE_URL). QWEN_QA_PYTHON picks the Python that has numpy,
 * scipy and praat-parselmouth (default python3).
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { pcmToWav } from "@/lib/tts/pcm-wav";
import { chunkQwenText, type QwenChunk } from "@/lib/tts/qwen-chunks";
import {
  QWEN_SAMPLE_RATE,
  decodeToPcm16,
  joinQwenChunks,
  repairQwenTake,
  toPcm16,
} from "@/lib/tts/qwen-join";
import {
  QWEN_DEFAULT_MODEL,
  candidateSeed,
  clampSeed,
  isQwenConfigured,
  qwenSynthesizeOnce,
  qwenSynthesizeWithRetry,
  renderQwenChunk,
  resolveQwenConfig,
  type QwenChunkTake,
  type QwenConfig,
  type QwenSynthFn,
  type QwenSynthRequest,
} from "@/lib/tts/providers/qwen";

type Args = {
  text: string;
  voice: string;
  seed: number;
  out: string;
  chars: number;
  chunkChars: number;
  concurrency: number;
  candidates: number;
  control: boolean;
  determinism: boolean;
  dryRun: boolean;
  fake: boolean;
  qa: boolean;
  maxChars: number;
  model: string;
  envFile?: string;
};

const USAGE = `usage: npx tsx scripts/qwen/ab-chapter.ts --text page.txt --voice <id> --out <dir>
  [--seed 42] [--chars 2600] [--chunk-chars 220] [--concurrency 3]
  [--control] [--candidates N] [--determinism] [--max-chars 12000]
  [--model qwen-audio-3.1-tts-flash] [--env-file .env.qwen]
  [--dry-run] [--fake] [--no-qa]`;

function parseArgs(argv: string[]): Args {
  const a: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (!k.startsWith("--")) throw new Error(`unexpected argument ${k}\n${USAGE}`);
    const name = k.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) a[name] = true;
    else {
      a[name] = next;
      i++;
    }
  }
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
  const num = (k: string, d: number) => (str(k) !== undefined ? Number(str(k)) : d);
  const fake = a.fake === true;
  const text = str("text");
  const out = str("out");
  const voice = str("voice") ?? (fake ? "fake-voice" : undefined);
  if (!text || !out || !voice) throw new Error(USAGE);
  return {
    text,
    voice,
    out,
    seed: clampSeed(num("seed", 42)),
    chars: num("chars", 2600),
    chunkChars: num("chunk-chars", 220),
    concurrency: Math.max(1, num("concurrency", 3)),
    candidates: Math.max(1, Math.min(5, num("candidates", 1))),
    control: a.control === true,
    determinism: a.determinism === true,
    dryRun: a["dry-run"] === true,
    fake,
    qa: a["no-qa"] !== true,
    maxChars: num("max-chars", 12_000),
    model: str("model") ?? QWEN_DEFAULT_MODEL,
    envFile: str("env-file"),
  };
}

/** The first `limit` characters of the text, ending on a paragraph or sentence. */
export function pageOf(text: string, limit: number): string {
  const paras = text.replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let used = 0;
  for (const p of paras) {
    if (used + p.length <= limit) {
      out.push(p);
      used += p.length + 2;
      continue;
    }
    if (!out.length || limit - used > 400) {
      const room = p.slice(0, Math.max(0, limit - used));
      const cut = Math.max(room.lastIndexOf(". "), room.lastIndexOf("? "), room.lastIndexOf("! "));
      if (cut > 0) out.push(room.slice(0, cut + 1));
    }
    break;
  }
  return out.join("\n\n");
}

function reversedParagraphs(page: string): string {
  return page.split(/\n\s*\n/).reverse().join("\n\n");
}

// ---------------------------------------------------------------- transport

/**
 * Offline stand-in for the speech API: voiced pulses at ~18 chars/s with
 * Flash's two signal faults (a 1.21 kHz line, digital-zero gaps), so the
 * pipeline and the QA can be exercised without a key.
 */
function fakeSynth(): QwenSynthFn {
  return async (req) => {
    const h = createHash("sha256").update(`${req.voice}|${req.seed}|${req.text}`).digest();
    let state = h.readUInt32LE(0) || 1;
    const rand = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return ((state >>> 0) % 1_000_000) / 1_000_000;
    };
    const seconds = Math.max(1, req.text.length / 18);
    const n = Math.round(seconds * QWEN_SAMPLE_RATE);
    const x = new Float32Array(n);
    let phase = 0;
    const words = req.text.split(/\s+/).length;
    const wordLen = n / Math.max(1, words);
    for (let i = 0; i < n; i++) {
      const w = Math.floor(i / wordLen);
      const inWord = (i - w * wordLen) / wordLen;
      const f0 = 110 + 20 * Math.sin(w * 1.3);
      phase += (2 * Math.PI * f0) / QWEN_SAMPLE_RATE;
      let v = 0;
      for (let k = 1; k < 12; k++) v += Math.sin(k * phase) / k;
      const env = inWord < 0.8 ? Math.sin((Math.PI * inWord) / 0.8) : 0;
      x[i] = env * (0.18 * v + 0.004 * Math.sin((2 * Math.PI * 1215 * i) / QWEN_SAMPLE_RATE)) + 0.003 * (rand() - 0.5) * env;
    }
    return {
      audio: pcmToWav(toPcm16(x), { sampleRate: QWEN_SAMPLE_RATE }),
      requestId: `fake-${h.toString("hex").slice(0, 8)}`,
      usage: { characters: req.text.length },
      audioHost: "fake.local",
      latencyMs: 0,
    };
  };
}

// ---------------------------------------------------------------- QA

function pythonBin(): string {
  return process.env.QWEN_QA_PYTHON || "python3";
}

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const QA_SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), "artifact_qa.py");

async function harmScorer(dir: string) {
  let n = 0;
  return async (audio: Buffer): Promise<number | null> => {
    const file = path.join(dir, `cand-${n++}.mp3`);
    await writeFile(file, audio);
    const r = await run(pythonBin(), [QA_SCRIPT, file]);
    try {
      const line = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
      return typeof line.harm_badness_median === "number" ? line.harm_badness_median : null;
    } catch {
      return null;
    }
  };
}

type QaRow = Record<string, unknown> & {
  file: string;
  windows?: { t0: number; line_db: number | null; cuts_per_min: number; harm_badness: number | null }[];
  onset_vs_rest?: Record<string, { first: number | null; rest: number | null }>;
};

function fmt(v: unknown, d = 2): string {
  return typeof v === "number" ? v.toFixed(d) : v === null || v === undefined ? "–" : String(v);
}

function report(args: Args, plan: Plan, qa: QaRow[], notes: string[]): string {
  const lines: string[] = [];
  lines.push(`# Qwen Flash A/B — ${new Date().toISOString()}`, "");
  lines.push(
    `Model \`${args.model}\`, seed ${args.seed}, page ${plan.pageChars} chars in ${plan.chunks.length} chunks ` +
      `(target ${args.chunkChars}). Voice id is in plan.json.`,
    ""
  );
  lines.push(
    "| arm | s | line dB | cuts/min | steep/min | dig. silence % | harm median | harm stable | flags |",
    "|---|---|---|---|---|---|---|---|---|"
  );
  for (const r of qa) {
    lines.push(
      `| ${r.file.replace(/\.mp3$/, "")} | ${fmt(r.duration_s, 1)} | ${fmt(r.line_db)} | ${fmt(r.cuts_per_min, 1)} | ` +
        `${fmt(r.steep_decays_per_min, 1)} | ${fmt(r.digital_silence_pct, 1)} | ${fmt(r.harm_badness_median, 3)} | ` +
        `${fmt(r.harm_badness_stable, 3)} | ${(r.flags as string[] | undefined)?.join(", ") || ""} |`
    );
  }
  lines.push("", "## First 20 s vs the rest (per-4 s windows)", "");
  lines.push("| arm | line first / rest | cuts/min first / rest | harm first / rest |", "|---|---|---|---|");
  for (const r of qa) {
    const o = r.onset_vs_rest;
    if (!o) continue;
    lines.push(
      `| ${r.file.replace(/\.mp3$/, "")} | ${fmt(o.line_db?.first)} / ${fmt(o.line_db?.rest)} | ` +
        `${fmt(o.cuts_per_min?.first, 1)} / ${fmt(o.cuts_per_min?.rest, 1)} | ` +
        `${fmt(o.harm_badness?.first, 3)} / ${fmt(o.harm_badness?.rest, 3)} |`
    );
  }
  lines.push(
    "",
    "## Reading it",
    "",
    "- Long-call drift is real only if `single` is worse after 20 s than before **and** `control` " +
      "(the same words, reversed) is too. If only one of them drifts, the words drive it, not the call length.",
    "- Chunking helps only if `chunked` beats `single` on harm stable by more than ~0.1 (smaller is within " +
      "the measurement spread of one take).",
    "- `*-post` arms re-process the same audio: they show what the repairs do to line, cuts, steep decays " +
      "and digital silence. Their cut count is low partly by construction (the bed lifts the floor); " +
      "steep/min is the check that does not depend on the floor.",
    "- Listen before deciding; these numbers rank takes, they do not replace ears."
  );
  if (notes.length) lines.push("", "## Notes", "", ...notes.map((n) => `- ${n}`));
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------- main

type Plan = {
  page: string;
  pageChars: number;
  chunks: QwenChunk[];
  arms: { arm: string; calls: number; chars: number }[];
  totalCalls: number;
  totalChars: number;
};

function makePlan(args: Args, page: string, chunks: QwenChunk[]): Plan {
  const chunkChars = chunks.reduce((s, c) => s + c.text.length, 0);
  const arms = [
    { arm: "single", calls: 1, chars: page.length },
    { arm: "single-post", calls: 0, chars: 0 },
    { arm: "chunked", calls: chunks.length, chars: chunkChars },
    { arm: "chunked-post", calls: 0, chars: 0 },
  ];
  if (args.control) arms.push({ arm: "control", calls: 1, chars: page.length });
  if (args.candidates > 1) {
    arms.push({ arm: "chunked-best", calls: chunks.length * (args.candidates - 1), chars: chunkChars * (args.candidates - 1) });
  }
  if (args.determinism) arms.push({ arm: "determinism", calls: 1, chars: chunks[0]?.text.length ?? 0 });
  return {
    page,
    pageChars: page.length,
    chunks,
    arms,
    totalCalls: arms.reduce((s, a) => s + a.calls, 0),
    totalChars: arms.reduce((s, a) => s + a.chars, 0),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.envFile) loadEnv({ path: args.envFile, quiet: true });

  const source = await readFile(args.text, "utf8");
  const page = pageOf(source, args.chars);
  const chunks = chunkQwenText(page, { targetChars: args.chunkChars });
  const plan = makePlan(args, page, chunks);

  console.log(
    `page ${plan.pageChars} chars, ${chunks.length} chunks; ${plan.totalCalls} API calls, ${plan.totalChars} billed chars`
  );
  for (const a of plan.arms) console.log(`  ${a.arm.padEnd(13)} calls ${String(a.calls).padStart(3)}  chars ${a.chars}`);
  if (plan.totalChars > args.maxChars) {
    throw new Error(`plan needs ${plan.totalChars} chars, over --max-chars ${args.maxChars}`);
  }
  if (args.dryRun) return;
  if (!args.fake && !isQwenConfigured()) {
    throw new Error("set DASHSCOPE_API_KEY and DASHSCOPE_WORKSPACE_ID (or pass --env-file, or --fake)");
  }

  const out = path.resolve(args.out);
  await mkdir(path.join(out, "chunks"), { recursive: true });
  await writeFile(
    path.join(out, "plan.json"),
    JSON.stringify(
      { ...plan, voice: args.voice, seed: args.seed, model: args.model, fake: args.fake, chunkChars: args.chunkChars },
      null,
      1
    )
  );
  const runsFile = path.join(out, "runs.jsonl");
  await writeFile(runsFile, "");
  const log = (row: Record<string, unknown>) => appendFile(runsFile, `${JSON.stringify(row)}\n`);

  const config: QwenConfig | undefined = args.fake ? { apiKey: "fake", baseUrl: "https://fake.local", model: args.model } : resolveQwenConfig();
  const synth: QwenSynthFn = args.fake ? fakeSynth() : qwenSynthesizeOnce;
  const notes: string[] = [];
  if (args.fake) notes.push("Offline --fake transport: synthetic audio, not Qwen. Checks the pipeline only.");

  const call = async (arm: string, chunk: number | null, req: QwenSynthRequest) => {
    const res = await qwenSynthesizeWithRetry(
      { ...req, model: args.model },
      { synth, config, onAttempt: (i) => i.error && console.warn(`  ${arm}#${chunk ?? "-"} attempt ${i.attempt}: ${i.error}`) }
    );
    await log({
      arm,
      chunk,
      chars: req.text.length,
      seed: req.seed,
      request_id: res.requestId,
      audio_host: res.audioHost,
      latency_ms: res.latencyMs,
      attempts: res.attempts,
      bytes: res.audio.length,
      usage: res.usage,
    });
    return res;
  };
  const files: string[] = [];
  const save = async (name: string, audio: Buffer) => {
    const f = path.join(out, name);
    await writeFile(f, audio);
    if (name.endsWith(".mp3") && !name.includes("/")) files.push(f);
  };
  const asMp3 = async (audio: Buffer) => {
    const j = await joinQwenChunks([{ audio, boundary: "start" }], { post: { deline: false, degate: false } });
    return j.audio;
  };

  console.log("single …");
  const single = await call("single", null, { text: page, voice: args.voice, seed: args.seed });
  // Keep the provider bytes as they came when they are already MP3.
  const singleMp3 = args.fake ? await asMp3(single.audio) : single.audio;
  await save("single.mp3", singleMp3);
  await save("single-post.mp3", await repairQwenTake(singleMp3, { deline: true, degate: true }));

  console.log(`chunked (${chunks.length}) …`);
  const takes: QwenChunkTake[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(args.concurrency, chunks.length) }, async () => {
      while (next < chunks.length) {
        const c = chunks[next++]!;
        const r = await call("chunked", c.index, { text: c.text, voice: args.voice, seed: args.seed });
        takes[c.index] = {
          chunk: c,
          audio: r.audio,
          seed: args.seed,
          score: null,
          requestId: r.requestId,
          usage: r.usage,
          attempts: r.attempts,
          latencyMs: r.latencyMs,
          candidates: [],
        };
        await save(`chunks/chunked-${String(c.index).padStart(2, "0")}.${args.fake ? "wav" : "mp3"}`, r.audio);
      }
    })
  );
  const pieces = takes.map((t) => ({ audio: t.audio, boundary: t.chunk.boundary }));
  const raw = await joinQwenChunks(pieces, { post: { deline: false, degate: false } });
  await save("chunked.mp3", raw.audio);
  const post = await joinQwenChunks(pieces, { post: { deline: true, degate: true } });
  await save("chunked-post.mp3", post.audio);
  notes.push(`Chunk gains (dB): ${raw.gainsDb.map((g) => g.toFixed(1)).join(", ")}`);

  if (args.control) {
    console.log("control (reversed paragraphs) …");
    const c = await call("control", null, { text: reversedParagraphs(page), voice: args.voice, seed: args.seed });
    await save("control.mp3", args.fake ? await asMp3(c.audio) : c.audio);
  }

  if (args.candidates > 1) {
    console.log(`chunked-best (${args.candidates} seeds per chunk) …`);
    const scorer = await harmScorer(path.join(out, "chunks"));
    const best: QwenChunkTake[] = [];
    for (const c of chunks) {
      // Seed k=0 is the chunked arm's take; only the extra seeds cost calls.
      const extra = await renderQwenChunk(c, {
        voice: args.voice,
        model: args.model,
        seed: candidateSeed(args.seed, 1),
        candidates: args.candidates - 1,
        scorer,
        config,
        synth: async (req, o) => {
          const r = await synth(req, o);
          await log({ arm: "chunked-best", chunk: c.index, chars: req.text.length, seed: req.seed, request_id: r.requestId, audio_host: r.audioHost, latency_ms: r.latencyMs, bytes: r.audio.length, usage: r.usage });
          return r;
        },
      });
      const baseScore = await scorer(takes[c.index]!.audio);
      const pick =
        baseScore !== null && (extra.score === null || baseScore <= extra.score) ? { ...takes[c.index]!, score: baseScore } : extra;
      best.push(pick);
      notes.push(
        `chunk ${c.index}: seed ${args.seed} harm ${fmt(baseScore, 3)}; ` +
          extra.candidates.map((k) => `seed ${k.seed} harm ${fmt(k.score, 3)}`).join("; ") +
          ` → kept seed ${pick.seed}`
      );
    }
    const joined = await joinQwenChunks(
      best.map((t) => ({ audio: t.audio, boundary: t.chunk.boundary })),
      { post: { deline: true, degate: true } }
    );
    await save("chunked-best.mp3", joined.audio);
  }

  if (args.determinism && chunks[0]) {
    console.log("determinism …");
    const again = await call("determinism", 0, { text: chunks[0].text, voice: args.voice, seed: args.seed });
    const a = takes[0]!.audio;
    const same = a.equals(again.audio);
    let pcmSame = same;
    if (!same) {
      const [pa, pb] = await Promise.all([decodeToPcm16(a), decodeToPcm16(again.audio)]);
      pcmSame = pa.equals(pb);
    }
    notes.push(
      `Determinism: chunk 0 rendered twice with seed ${args.seed} → ` +
        (same ? "byte-identical." : pcmSame ? "same samples, different container bytes." : "different audio.")
    );
  }

  let qa: QaRow[] = [];
  if (args.qa) {
    console.log("scoring …");
    const r = await run(pythonBin(), [
      QA_SCRIPT,
      ...files,
      "--window",
      "4",
      "--stable-harm",
      "--json",
      path.join(out, "qa.json"),
      "--csv",
      path.join(out, "windows.csv"),
    ]);
    if (r.code !== 0) {
      notes.push(`artifact_qa.py failed (exit ${r.code}): ${r.stderr.trim().split("\n").pop()}`);
    } else {
      qa = JSON.parse(await readFile(path.join(out, "qa.json"), "utf8"));
      if (/parselmouth not installed/.test(r.stderr)) notes.push("praat-parselmouth missing: harm columns are empty.");
    }
  }
  await writeFile(path.join(out, "report.md"), report(args, plan, qa, notes));
  console.log(`done → ${path.join(out, "report.md")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
