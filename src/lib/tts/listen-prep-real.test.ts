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

/**
 * eaa0005 body-sentence cap: restore body lines when most of them are dropped,
 * then shed to 40%. Main's digit-stripped header pre-pass is not part of this
 * comparison; the strict pre-pass is applied only on the PR side.
 */
function mainSettle(chunk: string, ops: ListenOps): number[] {
  const lines = lineSpans(chunk);
  ops = withoutProseDrops(chunk, ops);
  if (ops.drop.length === 0 || lines.length === 0) return [];
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
  if (drop.length === 0) return [];
  const text = applyListenOps(chunk, { ...ops, drop });
  if (!text.trim()) return [];
  return drop;
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
    for (const [key, row] of table) {
      const prRecall = row.prRecall / row.calls;
      const mainRecall = row.mainRecall / row.calls;
      expect(prRecall, key).toBeGreaterThanOrEqual(mainRecall - 1e-9);
    }
  });
});
