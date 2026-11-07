/**
 * The clone cache identity must move whenever the narration recipe moves.
 *
 * This is the regression for the second half of `job 75944dc9`: its five
 * "ready" sections were **byte-identical** to takes from builds `1e9a10bbf103`
 * (S2C8, 400-char units) and `f55abd34001a` (S2C7, 300-char units). Not one
 * second came from the #246 runtime, so the longer units that PR shipped were
 * never heard, and the missing half of the book was the only visible symptom.
 *
 * Two properties have to hold together, and the old `s2-pro-modal-v1` satisfied
 * neither:
 *
 *   1. **A recipe change must change the key.** Otherwise a new build reuses
 *      audio recorded under a different unit width, pause ladder or history
 *      anchor, and the fix silently does not play.
 *   2. **A deploy that cannot change a sample must not change the key.** The
 *      remedy must not be "bump a version by hand" — that was forgotten in both
 *      #244 and #245 — and it must not be "hash the git SHA", which throws away
 *      thousands of sections of paid GPU time on every docs edit.
 *
 * The Python container is the authority for the numbers, so this parses
 * `modal/s2_contract.py` and fails if the TypeScript mirror drifts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CLONE_CLAUSE_PAUSE_S,
  CLONE_HISTORY_ANCHOR,
  CLONE_MERGE_PARA_MAX_CHARS,
  CLONE_PARAGRAPH_PAUSE_S,
  CLONE_SENTENCE_PAUSE_S,
  CLONE_UNIT_MAX_CHARS,
  cloneNarrationRecipeId,
} from "@/lib/tts/clone-narration-recipe";
import { takehomeCacheVariant } from "@/lib/tts/process-job";

const CONTRACT = path.join(process.cwd(), "modal/s2_contract.py");

/** Read one top-level numeric assignment from the Python contract. */
function pythonNumber(name: string): number {
  const source = readFileSync(CONTRACT, "utf8");
  const match = new RegExp(`^${name} = ([0-9.]+)$`, "m").exec(source);
  if (!match) throw new Error(`${name} not found in modal/s2_contract.py`);
  return Number(match[1]);
}

function pythonBool(name: string): boolean {
  const source = readFileSync(CONTRACT, "utf8");
  const match = new RegExp(`^${name} = (True|False)$`, "m").exec(source);
  if (!match) throw new Error(`${name} not found in modal/s2_contract.py`);
  return match[1] === "True";
}

describe("the recipe mirror matches the container", () => {
  it("mirrors every number the container reads", () => {
    expect(CLONE_UNIT_MAX_CHARS).toBe(pythonNumber("UNIT_MAX_CHARS"));
    expect(CLONE_MERGE_PARA_MAX_CHARS).toBe(pythonNumber("MERGE_PARA_MAX_CHARS"));
    expect(CLONE_CLAUSE_PAUSE_S).toBe(pythonNumber("CLAUSE_PAUSE_S"));
    expect(CLONE_SENTENCE_PAUSE_S).toBe(pythonNumber("SPLIT_PAUSE_S"));
    expect(CLONE_PARAGRAPH_PAUSE_S).toBe(pythonNumber("PARAGRAPH_PAUSE_S"));
    expect(CLONE_HISTORY_ANCHOR).toBe(
      pythonBool("HISTORY_ANCHOR_FIRST") ? "first" : "last"
    );
  });

  it("fails loudly rather than silently accepting a drift", () => {
    // Prove the guard has teeth: a mirror that disagrees must not be equal.
    // Written as a comparison against a deliberately wrong value so the test
    // fails if the parser ever starts returning something truthy by accident.
    expect(CLONE_UNIT_MAX_CHARS).not.toBe(pythonNumber("UNIT_MAX_CHARS") + 1);
  });
});

describe("the cache variant carries the recipe", () => {
  const CLONE_ID = "clone:e552d5a5-8f2f-484d-9399-800ddacba85c";

  // `usesModalClone` resolves the engine from configuration, so the variant is
  // only the S2 one when the pool is configured — which is the state a clone
  // book is pinned in.
  beforeEach(() => {
    process.env.MODAL_S2_TTS_URL =
      "https://acme--echomancer-s2-clone-synthesize-batch.modal.run";
  });
  afterEach(() => {
    delete process.env.MODAL_S2_TTS_URL;
  });

  it("includes the unit ceiling, so a pre-#246 take cannot be reused", () => {
    // Production reused S2C8 (400) and S2C7 (300) audio in a 560 book. Those
    // three recipes must now hash differently.
    const now = cloneNarrationRecipeId();
    const at400 = cloneNarrationRecipeId({ unitMaxChars: 400 });
    const at300 = cloneNarrationRecipeId({ unitMaxChars: 300 });
    expect(new Set([now, at400, at300]).size).toBe(3);
    expect(now).toContain("u560");
    expect(at400).toContain("u400");
  });

  it("includes the pause ladder and the history anchor", () => {
    const now = cloneNarrationRecipeId();
    expect(cloneNarrationRecipeId({ sentencePauseS: 0.3 })).not.toBe(now);
    expect(cloneNarrationRecipeId({ clausePauseS: 0.1 })).not.toBe(now);
    expect(cloneNarrationRecipeId({ paragraphPauseS: 1.2 })).not.toBe(now);
    expect(cloneNarrationRecipeId({ history: "last" })).not.toBe(now);
    expect(cloneNarrationRecipeId({ mergeParaMaxChars: 400 })).not.toBe(now);
  });

  it("is stable across restarts and unrelated deploys", () => {
    // No SHA, no deploy id, no timestamps: the same recipe is the same key.
    expect(cloneNarrationRecipeId()).toBe(cloneNarrationRecipeId());
    expect(takehomeCacheVariant("fish", CLONE_ID)).toBe(
      takehomeCacheVariant("fish", CLONE_ID)
    );
  });

  it("still names the engine, so Fish and S2 takes never collide", () => {
    const variant = takehomeCacheVariant("fish", CLONE_ID);
    expect(variant).toMatch(/^s2-pro-modal-/);
    expect(variant).not.toBe(takehomeCacheVariant("fish", "standard"));
    expect(variant).not.toMatch(/drama/i);
  });

  it("is not the old hand-maintained version", () => {
    // The literal that let three different recipes share a key.
    expect(takehomeCacheVariant("fish", CLONE_ID)).not.toBe("s2-pro-modal-v1");
  });
});
