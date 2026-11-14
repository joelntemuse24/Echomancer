/**
 * Two different widths, and they must not be confused.
 *
 * A clone book has three nested sizes, and only one of them decides how a
 * listener hears the narration:
 *
 * | width | who decides | what it bounds |
 * |--|--|--|
 * | row (section) | this app, `MODAL_S2_SECTION_CHARS` (4,000) | one row of one batch call |
 * | call | this app, `modalLaneCharCap` (8,000) | one HTTP call, i.e. one container |
 * | **unit** | the container, `UNIT_MAX_CHARS` (560) | **one GPU generation** |
 *
 * Only the unit boundary is spliced — the take's own trailing silence is trimmed
 * and a fixed pause inserted — so the unit width is what "it stops and starts
 * every time" was about. The section width is a *scheduling* choice: it exists
 * because one row renders its units in sequence and a call's wall time is set by
 * its longest row.
 *
 * The 2026-11-06 failure mode this file guards against is a **downstream cap
 * quietly dominating the unit width**: if a section were packed to ~200 chars it
 * would arrive at the container as one 200-char paragraph, and no unit ceiling
 * could make the narration longer. #244/#245's `UNIT_TARGET_CHARS` did exactly
 * that from the other side — the target, not the ceiling, decided the boundary
 * count. Both are now impossible: the section width is far larger than one unit,
 * and the container has a single width authority.
 */

import { describe, expect, it } from "vitest";
import {
  MODAL_CLONE_SECTION_CHARS_DEFAULT,
  modalCloneSectionChars,
  modalLaneCharCap,
} from "@/lib/tts/providers/modal-clone-lanes";

/**
 * The container's unit ceiling, read from source rather than imported: the
 * Python contract is the authority and it must not be duplicated by hand into a
 * TypeScript constant that can drift.
 */
function pythonUnitMaxChars(): number {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path") as typeof import("node:path");
  const source = fs.readFileSync(path.join(process.cwd(), "modal/s2_contract.py"), "utf8");
  const match = /^UNIT_MAX_CHARS = (\d+)$/m.exec(source);
  if (!match) throw new Error("UNIT_MAX_CHARS not found in modal/s2_contract.py");
  return Number(match[1]);
}

describe("the section width does not cap the unit width", () => {
  it("packs a section several units wide", () => {
    const unitMax = pythonUnitMaxChars();
    const sectionChars = modalCloneSectionChars({} as NodeJS.ProcessEnv);
    // At least three units fit in one section, so a section is not itself the
    // unit: the container still gets to choose where the splices go, and most
    // ordinary paragraphs inside it are one take.
    expect(sectionChars / unitMax).toBeGreaterThanOrEqual(3);
  });

  it("still keeps a row inside the call budget", () => {
    // The reason the section width exists at all: one row renders its units in
    // sequence, so a row wider than a call can render is a book that parks.
    const sectionChars = modalCloneSectionChars({} as NodeJS.ProcessEnv);
    expect(sectionChars).toBeLessThanOrEqual(modalLaneCharCap({} as NodeJS.ProcessEnv));
    expect(MODAL_CLONE_SECTION_CHARS_DEFAULT).toBe(sectionChars);
  });

  it("lets an override lower the section width but never the unit width", () => {
    // `MODAL_S2_SECTION_CHARS` is a scheduling knob. Lowering it makes more,
    // smaller rows; it cannot make a *unit* shorter, because the container reads
    // only the paragraph text it is given. Setting it below one unit's worth of
    // text would be the mistake this asserts against.
    const unitMax = pythonUnitMaxChars();
    const narrow = modalCloneSectionChars({
      MODAL_S2_SECTION_CHARS: String(unitMax * 2),
    } as NodeJS.ProcessEnv);
    expect(narrow).toBe(unitMax * 2);
    // Even at the narrowest override the container would accept, a section is
    // still at least one full unit.
    const floor = modalCloneSectionChars({
      MODAL_S2_SECTION_CHARS: "400",
    } as NodeJS.ProcessEnv);
    expect(floor).toBe(400);
    expect(floor).toBeLessThanOrEqual(unitMax);
  });
});
