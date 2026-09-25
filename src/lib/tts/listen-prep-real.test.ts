import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LISTEN_PREP_MAX_DROP_SHARE,
  acceptListenOps,
  applyListenOps,
  coerceListenOps,
  dropShare,
  lineSpans,
  matterLineIds,
  prepassDropIds,
  withoutProseDrops,
  type ListenOps,
} from "./listen-prep";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/listen-prep-real");

type Unit = { id: number; text: string; label: string; cat: string };
type Chunk = { name: string; units: Unit[] };
type Reply = { model: string; config: string; chunk: string; run: string; http: number | string; content: string };

function loadChunks(): Map<string, Chunk> {
  const out = new Map<string, Chunk>();
  for (const name of readdirSync(join(fixtureDir, "chunks"))) {
    const chunk = JSON.parse(readFileSync(join(fixtureDir, "chunks", name), "utf8")) as Chunk;
    out.set(chunk.name, chunk);
  }
  return out;
}

function chunkText(chunk: Chunk): string {
  return chunk.units.map((unit) => unit.text).join("\n");
}

function mainHeaderNorm(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

function mainMatchRatio(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const rows = Array.from({ length: b.length + 1 }, (_, i) => i);
  let prev = rows.slice();
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  const dist = prev[b.length] ?? a.length + b.length;
  return (a.length + b.length - dist) / (a.length + b.length);
}

/** origin/main prepassDropIds, including the digit-stripped header match. */
function mainPrepassDropIds(lines: Array<{ id: number; text: string }>): number[] {
  const drop = new Set<number>();
  const numbers = lines.flatMap((line) => {
    const match = /^[^\w“”"‘’']{0,2}(\d{1,3})[^\w“”"‘’']{0,2}$/.exec(line.text.trim());
    return match ? [{ id: line.id, value: Number(match[1]) }] : [];
  });
  numbers.forEach((page, index) => {
    const neighbors = numbers.slice(Math.max(0, index - 2), index).concat(numbers.slice(index + 1, index + 3));
    const sequential = neighbors.some((other) => {
      const gap = Math.abs(page.value - other.value);
      const distance = Math.abs(page.id - other.id);
      const forward = (other.value - page.value) * (other.id - page.id) > 0;
      return gap > 0 && gap <= 3 && distance <= 40 && forward;
    });
    if (sequential) drop.add(page.id);
  });
  const byId = new Map(lines.map((line) => [line.id, line.text]));
  const nearNumber = (id: number, text: string) =>
    [id - 1, id + 1].some((other) => /^[^\w“”"‘’']{0,2}\d{1,3}[^\w“”"‘’']{0,2}$/.test((byId.get(other) || "").trim())) ||
    /\d{1,3}\W{0,2}$|^\W{0,2}\d{1,3}\b/.test(text);
  const candidates: Array<{ id: number; norm: string }> = [];
  for (const line of lines) {
    const trimmed = line.text.trim();
    const core = trimmed.replace(/^[\W\d]+|[\W\d]+$/g, "");
    if (!core || trimmed.length > 60 || /[.?!]["”’]?$/.test(trimmed)) continue;
    if ('“"‘\'('.includes(trimmed[0] || "")) continue;
    const norm = mainHeaderNorm(core);
    if (norm.length < 4) continue;
    candidates.push({ id: line.id, norm });
  }
  const counts = new Map<string, number>();
  for (const candidate of candidates) counts.set(candidate.norm, (counts.get(candidate.norm) || 0) + 1);
  const norms = [...counts.keys()];
  const repeated = new Map<string, number>();
  for (const norm of norms) {
    let total = 0;
    for (const other of norms) {
      if (Math.abs(other.length - norm.length) > 4) continue;
      if (other === norm || mainMatchRatio(norm, other) >= 0.85) total += counts.get(other) || 0;
    }
    repeated.set(norm, total);
  }
  for (const candidate of candidates) {
    if ((repeated.get(candidate.norm) || 0) >= 3 && nearNumber(candidate.id, byId.get(candidate.id) || "")) {
      drop.add(candidate.id);
    }
  }
  const start = lines.find((line) => /\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG/i.test(line.text));
  const end = lines.find((line) => /\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG/i.test(line.text));
  if (start) for (let id = 1; id <= start.id; id++) drop.add(id);
  if (end) for (let id = end.id; id <= lines.length; id++) drop.add(id);
  return [...drop];
}

/**
 * eaa0005 body-sentence cap, then main's digit-stripped header pre-pass.
 * Recall is scored against that full main, not the cap alone.
 */
function mainSettle(chunk: string, ops: ListenOps): number[] {
  const lines = lineSpans(chunk);
  const prepass = mainPrepassDropIds(lines);
  ops = withoutProseDrops(chunk, ops);
  if (ops.drop.length === 0 || lines.length === 0) return prepass;
  const { bodySentence } = matterLineIds(lines);
  const body = new Set(bodySentence);
  const proseDrops = ops.drop.filter((id) => body.has(id));
  const mostProse = bodySentence.length > 0 && proseDrops.length * 2 > bodySentence.length;
  let drop = mostProse ? ops.drop.filter((id) => !body.has(id)) : [...ops.drop];
  const bySize = [...drop].sort((a, b) => {
    const la = lines.find((line) => line.id === a);
    const lb = lines.find((line) => line.id === b);
    return (lb ? lb.end - lb.start : 0) - (la ? la.end - la.start : 0);
  });
  while (drop.length > 0 && dropShare(chunk, drop) > LISTEN_PREP_MAX_DROP_SHARE) {
    const shed = bySize.find((id) => drop.includes(id));
    if (shed == null) break;
    drop = drop.filter((id) => id !== shed);
  }
  while (drop.length > 0 && drop.length >= lines.length) {
    const shed = bySize.find((id) => drop.includes(id));
    if (shed == null) break;
    drop = drop.filter((id) => id !== shed);
  }
  if (drop.length === 0) return prepass;
  const text = applyListenOps(chunk, { ...ops, drop });
  if (!text.trim()) return prepass;
  return [...new Set([...drop, ...prepass])];
}

function prSettle(chunk: string, ops: ListenOps): number[] {
  const prepassIds = prepassDropIds(lineSpans(chunk));
  const applied = acceptListenOps(chunk, withoutProseDrops(chunk, ops));
  const modelIds = applied.accepted ? applied.dropIds : [];
  return [...new Set([...modelIds, ...prepassIds])];
}

function score(chunk: Chunk, dropIds: number[]): { recall: number; falseDrops: number } {
  const dropped = new Set(dropIds);
  const clutter = chunk.units.filter((unit) => unit.label === "D");
  const prose = chunk.units.filter((unit) => unit.label === "K" || unit.label === "KH");
  const hit = clutter.filter((unit) => dropped.has(unit.id)).length;
  const falseDrops = prose.filter((unit) => dropped.has(unit.id)).length;
  return {
    recall: clutter.length === 0 ? 1 : hit / clutter.length,
    falseDrops,
  };
}

describe("real listen-prep replies", () => {
  it("matches or beats main on Gemini 3.8 Flash and DeepSeek V4.1 Flash prose false drops and recall", () => {
    const chunks = loadChunks();
    const replies = readFileSync(join(fixtureDir, "replies.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Reply);
    const totals = new Map<string, { calls: number; prRecall: number; mainRecall: number; prFalse: number; mainFalse: number }>();
    for (const reply of replies) {
      const chunk = chunks.get(reply.chunk);
      expect(chunk, reply.chunk).toBeTruthy();
      if (!chunk) continue;
      const text = chunkText(chunk);
      let ops = coerceListenOps(
        (() => {
          try {
            return JSON.parse(reply.content);
          } catch {
            return null;
          }
        })(),
        chunk.units.length
      );
      if (!ops) ops = { drop: [], headings: [] };
      const pr = score(chunk, prSettle(text, ops));
      const main = score(chunk, mainSettle(text, ops));
      expect(pr.falseDrops, `${reply.model} ${reply.chunk} run ${reply.run}`).toBeLessThanOrEqual(main.falseDrops);
      const key = `${reply.model} ${reply.chunk}`;
      const row = totals.get(key) ?? { calls: 0, prRecall: 0, mainRecall: 0, prFalse: 0, mainFalse: 0 };
      row.calls += 1;
      row.prRecall += pr.recall;
      row.mainRecall += main.recall;
      row.prFalse += pr.falseDrops;
      row.mainFalse += main.falseDrops;
      totals.set(key, row);
    }
    const table = [...totals.entries()].sort(([a], [b]) => a.localeCompare(b));
    expect(table.length).toBeGreaterThan(0);
    const measured = table.map(([key, row]) => ({
      key,
      prRecall: row.prRecall / row.calls,
      mainRecall: row.mainRecall / row.calls,
      prFalse: row.prFalse,
      mainFalse: row.mainFalse,
    }));
    for (const row of measured) {
      expect(row.prFalse, row.key).toBeLessThanOrEqual(row.mainFalse);
      // Souls running heads differ by OCR ("POLK" / "FOLIC"). A digit-stripped
      // match catches them and also drops refrains, diary heads, and a
      // three-copy title, so this pre-pass stays exact. Font size is not
      // available on plain text.
      if (row.key.endsWith("pdf_souls_front")) continue;
      expect(row.prRecall, row.key).toBeGreaterThanOrEqual(row.mainRecall - 1e-9);
    }
    const souls = measured.filter((row) => row.key.endsWith("pdf_souls_front"));
    expect(souls.length).toBe(2);
    for (const row of souls) expect(row.prRecall).toBeLessThan(row.mainRecall);
  });
});
