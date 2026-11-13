/**
 * Short-book GPU cost, before and after longer sections.
 *
 * The "before" rows were simulated on e84c389 (PR 282): section 0 at 1,000
 * characters, later rows grown to leave 15s at 1.5× and then capped at
 * 2,000, the long-book audio ramp still in place, and 45s of idle scaledown.
 * Dollars use the planner curve (about 2.8× for one row, about 8.8× at four
 * or more) plus restore and idle at $3.95/h. That curve is slower than the
 * measured 24-row smoke (~33×, about $0.14 per audio hour). A 13-row call
 * is not that smoke. These figures are estimates.
 */
import { describe, expect, it } from "vitest";
import {
  H100_USD_PER_HOUR,
  MODAL_CLONE_CHARS_PER_AUDIO_SECOND,
  MODAL_CLONE_OPENING_SECTION_CHARS,
  MODAL_CLONE_SECTION_CHARS_DEFAULT,
  cloneBookGpuBill,
  coldClonePackFitsAbort,
  planCloneSectionChars,
} from "@/lib/tts/providers/modal-clone-lanes";
import { MODAL_CLONE_SCALEDOWN_TARGET_S } from "@/lib/tts/providers/modal-clone-guard";

const ELEVEN_MIN_CHARS = Math.round(11 * 60 * MODAL_CLONE_CHARS_PER_AUDIO_SECOND);
/** About two short pages: two minutes of speech. */
const TWO_PAGE_CHARS = Math.round(120 * MODAL_CLONE_CHARS_PER_AUDIO_SECOND);
const TEN_HOUR_CHARS = Math.round(10 * 3600 * MODAL_CLONE_CHARS_PER_AUDIO_SECOND);

type BeforeBill = {
  sections: number;
  widths: number[];
  calls: number;
  idleMs: number;
  usd: number;
};

/** e84c389 planner, 45s idle, cold opening. */
const BEFORE: Record<"eleven" | "twoPage" | "tenHour", BeforeBill> = {
  eleven: { sections: 7, widths: [1, 6], calls: 2, idleMs: 45_000, usd: 0.1999 },
  twoPage: { sections: 2, widths: [1, 1], calls: 2, idleMs: 45_000, usd: 0.1455 },
  tenHour: {
    sections: 287,
    widths: [1, 1, 3, 7, 24],
    calls: 16,
    idleMs: 45_000,
    usd: 4.8398,
  },
};

function dollars(usd: number): number {
  return Math.round(usd * 10_000) / 10_000;
}

describe("clone section width", () => {
  it("keeps the opening quick and the rest at the steady width", () => {
    expect(MODAL_CLONE_OPENING_SECTION_CHARS).toBe(1_000);
    expect(MODAL_CLONE_SECTION_CHARS_DEFAULT).toBe(4_000);
    expect(MODAL_CLONE_SECTION_CHARS_DEFAULT).toBeGreaterThan(2_000);
    const cold = coldClonePackFitsAbort({
      chars: MODAL_CLONE_SECTION_CHARS_DEFAULT,
      largestRow: MODAL_CLONE_SECTION_CHARS_DEFAULT,
      rows: 1,
      raceForFirstAudio: false,
    });
    expect(cold.fits).toBe(true);
    expect(
      coldClonePackFitsAbort({
        chars: 6_400,
        largestRow: 6_400,
        rows: 1,
        raceForFirstAudio: false,
      }).fits
    ).toBe(false);
  });

  it("packs an 11-minute book, a 2-page article, and a 10-hour book", () => {
    expect(ELEVEN_MIN_CHARS).toBe(10_461);
    expect(planCloneSectionChars(ELEVEN_MIN_CHARS)).toEqual([1_000, 4_000, 4_000, 1_461]);
    expect(TWO_PAGE_CHARS).toBe(1_902);
    expect(planCloneSectionChars(TWO_PAGE_CHARS)).toEqual([1_000, 902]);
    const ten = planCloneSectionChars(TEN_HOUR_CHARS);
    expect(ten[0]).toBe(1_000);
    expect(ten[1]).toBe(4_000);
    expect(ten.length).toBeLessThan(BEFORE.tenHour.sections);
    expect(MODAL_CLONE_SCALEDOWN_TARGET_S).toBe(15);
    expect(H100_USD_PER_HOUR).toBe(3.95);
  });
});

describe("estimated GPU bill", () => {
  it("bills the 11-minute book below the old cold plan once idle is 15s", () => {
    const sections = planCloneSectionChars(ELEVEN_MIN_CHARS);
    const cold = cloneBookGpuBill({ sectionChars: sections });
    const warm = cloneBookGpuBill({ sectionChars: sections, poolWarm: true });
    const hitch = cloneBookGpuBill({ sectionChars: sections, poolWarm: true, idleMs: 0 });
    expect(cold.widths).toEqual([1, 3]);
    expect(cold.idleMs).toBe(15_000);
    expect(dollars(cold.usd)).toBeLessThan(BEFORE.eleven.usd);
    expect(dollars(warm.usd)).toBeLessThan(dollars(cold.usd));
    expect(warm.wallMs).toBe(cold.wallMs - 38_000);
    expect(dollars(hitch.usd)).toBeLessThan(dollars(warm.usd));
    expect(cold.calls).toBeLessThan(BEFORE.eleven.sections);
  });

  it("bills a 2-page article well under the old restore-plus-45s plan", () => {
    const sections = planCloneSectionChars(TWO_PAGE_CHARS);
    const cold = cloneBookGpuBill({ sectionChars: sections });
    const warm = cloneBookGpuBill({ sectionChars: sections, poolWarm: true });
    expect(cold.widths).toEqual([1, 1]);
    expect(dollars(cold.usd)).toBeLessThan(BEFORE.twoPage.usd);
    expect(dollars(warm.usd)).toBeLessThan(dollars(cold.usd));
    expect(warm.wallMs).toBeLessThan(60_000);
  });

  it("sends a 10-hour book to full batches after the opening", () => {
    const sections = planCloneSectionChars(TEN_HOUR_CHARS);
    const bill = cloneBookGpuBill({ sectionChars: sections });
    expect(bill.widths[0]).toBe(1);
    expect(bill.widths[1]).toBeGreaterThanOrEqual(8);
    // About 13 rows, not the old 24. The planner prices both at ~8.8×, so
    // its dollar figure does not show a real slowdown from giving up the
    // measured ~33× of a 24-row call.
    expect(Math.max(...bill.widths)).toBeLessThan(24);
    expect(Math.max(...bill.widths)).toBeGreaterThanOrEqual(8);
    expect(bill.calls).toBeLessThan(BEFORE.tenHour.calls);
    expect(bill.idleMs).toBe(15_000);
    expect(dollars(bill.usd)).toBeGreaterThan(4);
    expect(dollars(bill.usd)).toBeLessThan(6);
  });
});
