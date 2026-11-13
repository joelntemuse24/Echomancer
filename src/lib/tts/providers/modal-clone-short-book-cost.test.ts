/**
 * Short-book GPU cost, before and after longer sections.
 *
 * The "before" rows were simulated on e84c389 (PR 282): section 0 at 1,000
 * characters, later rows grown to leave 15s at 1.5× and then capped at
 * 2,000, the long-book audio ramp still in place, and 45s of idle scaledown.
 * Dollars use the planner curve (about 2.8× for one row, about 8.8× at
 * four, and the measured 24-row smoke at about 33×, with the widths
 * between four and 24 interpolated) plus restore and idle at $3.95/h.
 * A 14-row page has not been measured on its own. These figures are
 * estimates. The R2 page is the measured 24-row rate; the HTTP body of
 * that page is keys, and the MP3s are objects.
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
  MODAL_CLONE_RESPONSE_BODY_MAX_BYTES,
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

  it("sends a 10-hour book as 14-row pages after the opening", () => {
    const sections = planCloneSectionChars(TEN_HOUR_CHARS);
    const bill = cloneBookGpuBill({ sectionChars: sections });
    expect(bill.widths[0]).toBe(1);
    // 24 × 4,000 is about 130 MiB of base64. The body ceiling is 80 MiB,
    // so the page that fits is 14 × 4,000.
    expect(estimateCloneBatchJsonBytes(24 * 4_000)).toBeGreaterThan(
      MODAL_CLONE_RESPONSE_BODY_MAX_BYTES
    );
    expect(bill.widths.filter((rows) => rows === 14)).toHaveLength(10);
    expect(bill.widths[bill.widths.length - 1]).toBe(3);
    expect(bill.calls).toBe(12);
    expect(bill.calls).toBeLessThan(BEFORE.tenHour.calls);
    expect(bill.idleMs).toBe(15_000);
    const pageChars = 14 * 4_000;
    expect(pageChars).toBeLessThanOrEqual(modalWarmLaneCharLimit({} as NodeJS.ProcessEnv));
    expect(estimateCloneBatchJsonBytes(pageChars)).toBeLessThanOrEqual(
      MODAL_CLONE_RESPONSE_BODY_MAX_BYTES
    );
    const wall = cloneCallWallMs({
      chars: pageChars,
      largestRow: 4_000,
      rows: 14,
      shape: "warm",
      restore: false,
    });
    // About 186s. Comfortable under the 400s wait and the 542s proxy.
    expect(wall).toBeGreaterThan(150_000);
    expect(wall).toBeLessThan(240_000);
    expect(wall).toBeLessThan(400_000);
    const refused = cloneCallWallMs({
      chars: 24 * 4_000,
      largestRow: 4_000,
      rows: 24,
      shape: "warm",
      restore: false,
    });
    // The refused 24-row page would be about 3.5 minutes at the smoke rate.
    expect(refused).toBeGreaterThan(180_000);
    expect(refused).toBeLessThan(240_000);
    expect(refused).toBeLessThan(400_000);
    expect(dollars(bill.usd)).toBe(2.233);
  });

  it("sends a 10-hour book as 24-row pages once audio is stored", () => {
    const r2 = { MODAL_S2_AUDIO_TRANSPORT: "r2" } as NodeJS.ProcessEnv;
    const sections = planCloneSectionChars(TEN_HOUR_CHARS);
    const bill = cloneBookGpuBill({ sectionChars: sections, env: r2 });
    expect(bill.widths).toEqual([1, 24, 24, 24, 24, 24, 23]);
    expect(bill.calls).toBe(7);
    expect(bill.idleMs).toBe(15_000);
    const pageChars = 24 * 4_000;
    expect(pageChars).toBeLessThanOrEqual(modalWarmLaneCharLimit(r2));
    expect(cloneBatchHttpBytes(pageChars, 24, r2)).toBeLessThan(
      MODAL_CLONE_RESPONSE_BODY_MAX_BYTES
    );
    expect(estimateCloneObjectBytes(pageChars)).toBe(102_400_000);
    const wall = cloneCallWallMs({
      chars: pageChars,
      largestRow: 4_000,
      rows: 24,
      shape: "warm",
      restore: false,
    });
    expect(wall).toBe(211_055);
    expect(wall).toBeLessThan(400_000);
    expect(wall).toBeLessThan(542_000);
    expect(dollars(bill.usd)).toBe(1.4679);
    const eleven = cloneBookGpuBill({
      sectionChars: planCloneSectionChars(ELEVEN_MIN_CHARS),
      env: r2,
    });
    const two = cloneBookGpuBill({
      sectionChars: planCloneSectionChars(TWO_PAGE_CHARS),
      env: r2,
    });
    expect(eleven.widths).toEqual([1, 3]);
    expect(two.widths).toEqual([1, 1]);
  });
});
