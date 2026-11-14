/**
 * Clone GPU cost from the book's length.
 *
 * The "before" rows were simulated on e84c389 (PR 282): section 0 at 1,000
 * characters, later rows grown to leave 15s at 1.5× and then capped at
 * 2,000, the long-book audio ramp still in place, and 45s of idle scaledown.
 * Dollars use the planner curve (about 2.8× for one row, about 8.8× at
 * four, and the measured 24-row smoke at about 33×, with the widths
 * between four and 24 interpolated) plus restore and idle at $3.95/h.
 * A page that is not 1, 4, or 24 rows has not been measured on its own.
 * These figures are estimates. An R2 page's HTTP body is keys; the MP3s
 * are objects.
 */
import { describe, expect, it } from "vitest";
import {
  H100_USD_PER_HOUR,
  MODAL_CLONE_CHARS_PER_AUDIO_SECOND,
  MODAL_CLONE_OPENING_SECTION_CHARS,
  MODAL_CLONE_SECTION_CHARS_DEFAULT,
  cloneBatchHttpBytes,
  cloneBookGpuBill,
  cloneCallWallMs,
  coldClonePackFitsAbort,
  estimateCloneBatchJsonBytes,
  estimateCloneObjectBytes,
  modalWarmLaneCharLimit,
  planCloneSectionChars,
  simulateClonePlayback,
  MODAL_CLONE_RESPONSE_BODY_MAX_BYTES,
  MODAL_CLONE_SECTION_CHARS_MAX,
  MODAL_CLONE_SECTION_CHARS_MIN,
} from "@/lib/tts/providers/modal-clone-lanes";
import { MODAL_CLONE_SCALEDOWN_TARGET_S } from "@/lib/tts/providers/modal-clone-guard";

const ELEVEN_MIN_CHARS = Math.round(11 * 60 * MODAL_CLONE_CHARS_PER_AUDIO_SECOND);
/** About two short pages: two minutes of speech. */
const TWO_PAGE_CHARS = Math.round(120 * MODAL_CLONE_CHARS_PER_AUDIO_SECOND);
const ONE_HOUR_CHARS = Math.round(3600 * MODAL_CLONE_CHARS_PER_AUDIO_SECOND);
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
    expect(planCloneSectionChars(ELEVEN_MIN_CHARS)).toEqual([1_000, 3_154, 3_154, 3_153]);
    expect(TWO_PAGE_CHARS).toBe(1_902);
    expect(planCloneSectionChars(TWO_PAGE_CHARS)).toEqual([1_000, 902]);
    const ten = planCloneSectionChars(TEN_HOUR_CHARS);
    expect(ten[0]).toBe(1_000);
    expect(ten[1]).toBeGreaterThan(1_000);
    expect(ten[1]).toBeLessThan(2_500);
    expect(ten[2]).toBeGreaterThanOrEqual(MODAL_CLONE_SECTION_CHARS_MIN);
    expect(ten[2]).toBeLessThanOrEqual(MODAL_CLONE_SECTION_CHARS_MAX);
    for (const size of ten.slice(3)) {
      expect(size).toBeGreaterThanOrEqual(MODAL_CLONE_SECTION_CHARS_MIN);
      expect(size).toBeLessThanOrEqual(MODAL_CLONE_SECTION_CHARS_MAX);
    }
    expect(Math.max(...ten.slice(3)) - Math.min(...ten.slice(3))).toBeLessThanOrEqual(1);
    expect(ten.reduce((sum, size) => sum + size, 0)).toBe(TEN_HOUR_CHARS);
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

  it("plans each length as one opening, then as few wide calls as fit", () => {
    const inline = {} as NodeJS.ProcessEnv;
    const r2 = { MODAL_S2_AUDIO_TRANSPORT: "r2" } as NodeJS.ProcessEnv;
    const lengths = [
      { name: "two pages", chars: TWO_PAGE_CHARS, widths: [1, 1], usd: 0.1126 },
      { name: "11 minutes", chars: ELEVEN_MIN_CHARS, widths: [1, 3], usd: 0.1889 },
      { name: "1 hour", chars: ONE_HOUR_CHARS, widths: [1, 1, 1, 19], usd: 0.4045 },
    ] as const;
    for (const env of [inline, r2]) {
      for (const book of lengths) {
        const sections = planCloneSectionChars(book.chars, env);
        const bill = cloneBookGpuBill({ sectionChars: sections, env });
        expect(bill.widths, book.name).toEqual([...book.widths]);
        expect(dollars(bill.usd), book.name).toBe(book.usd);
        expect(bill.idleMs).toBe(15_000);
        assertCallsFit(sections, env);
      }
    }
    const inlineTen = planCloneSectionChars(TEN_HOUR_CHARS, inline);
    const inlineBill = cloneBookGpuBill({ sectionChars: inlineTen, env: inline });
    expect(inlineBill.widths).toEqual([1, 1, 1, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22]);
    expect(inlineBill.calls).toBe(13);
    expect(dollars(inlineBill.usd)).toBe(1.725);
    expect(dollars(inlineBill.usd)).toBeLessThan(2.233);
    const storedTen = planCloneSectionChars(TEN_HOUR_CHARS, r2);
    const storedBill = cloneBookGpuBill({ sectionChars: storedTen, env: r2 });
    expect(storedBill.widths).toEqual([1, 1, 1, 24, 24, 24, 24, 24, 24]);
    expect(storedBill.calls).toBe(9);
    expect(dollars(storedBill.usd)).toBe(1.619);
    expect(storedBill.calls).toBeLessThan(BEFORE.tenHour.calls);
    assertCallsFit(inlineTen, inline);
    assertCallsFit(storedTen, r2);
    // 24 × 4,000 of inline MP3 is about 130 MiB. The body ceiling is 80 MiB.
    expect(estimateCloneBatchJsonBytes(24 * 4_000)).toBeGreaterThan(
      MODAL_CLONE_RESPONSE_BODY_MAX_BYTES
    );
    const refused = cloneCallWallMs({
      chars: 24 * 4_000,
      largestRow: 4_000,
      rows: 24,
      shape: "warm",
      restore: false,
    });
    expect(refused).toBe(211_055);
    expect(refused).toBeLessThan(400_000);
    expect(modalWarmLaneCharLimit(inline)).toBeLessThan(15 * 4_000);
    expect(modalWarmLaneCharLimit(r2)).toBeGreaterThanOrEqual(24 * 4_000);
  });
});

function assertCallsFit(sections: number[], env: NodeJS.ProcessEnv): void {
  const report = simulateClonePlayback({ sectionChars: sections, batch: 24, env });
  const steady = report.steps.slice(3);
  if (steady.length > 1) {
    const widths = steady.map((step) => step.rows);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  }
  for (const step of report.steps) {
    expect(step.wallMs).toBeLessThan(400_000);
    expect(step.wallMs).toBeLessThan(542_000);
    if (step.rows > 1) expect(step.wallMs).toBeLessThan(340_000);
    expect(cloneBatchHttpBytes(step.chars, step.rows, env)).toBeLessThanOrEqual(
      MODAL_CLONE_RESPONSE_BODY_MAX_BYTES
    );
    if (env.MODAL_S2_AUDIO_TRANSPORT === "r2" && step.rows > 1) {
      expect(cloneBatchHttpBytes(step.chars, step.rows, env)).toBeLessThan(20_000);
      expect(estimateCloneObjectBytes(step.chars)).toBeGreaterThan(step.chars);
    }
  }
}
