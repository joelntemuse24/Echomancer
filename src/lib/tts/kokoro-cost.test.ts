import { describe, expect, it } from "vitest";
import { CPU_SCALEDOWN_DEFAULT_S } from "@/lib/capacity/cpu-warm-keepalive";
import {
  cpuAppUsdPerSecond,
  kokoroLanePlan,
  modelCpuIdleTails,
  modelKokoroSpeech,
} from "./kokoro-cost";

describe("kokoro cost model", () => {
  it("keeps the short book's wave count and bills fewer containers", () => {
    // 15.7k characters at ~700 characters a section is about 22 sections,
    // and the audit's 14.4 minutes of audio is 864 seconds.
    const sections = 22;
    const sectionAudioSec = 864 / sections;
    const lanes = kokoroLanePlan(sections);
    expect(lanes).toEqual({ before: 16, after: 11 });
    const shared = { sections, sectionAudioSec, rtf: 2.2, bootSec: 20, idleSec: 5 };
    const before = modelKokoroSpeech({ ...shared, lanes: lanes.before });
    const after = modelKokoroSpeech({ ...shared, lanes: lanes.after });
    expect(after.waves).toBe(before.waves);
    expect(after.waves).toBe(2);
    expect(after.wallSec).toBeCloseTo(before.wallSec, 6);
    expect(after.containerSec).toBeLessThan(before.containerSec);
    expect(after.usd).toBeLessThan(before.usd);
  });

  it("does not take lanes away from a long book", () => {
    // ~500k characters at 700 characters a section.
    const sections = Math.round(500_000 / 700);
    const lanes = kokoroLanePlan(sections);
    expect(lanes.before).toBe(16);
    expect(lanes.after).toBe(16);
    const sectionAudioSec = (500_000 / 18.2) / sections;
    const bill = modelKokoroSpeech({
      sections,
      lanes: lanes.after,
      sectionAudioSec,
      rtf: 2.2,
      bootSec: 20,
      idleSec: 5,
    });
    expect(bill.waves).toBe(Math.ceil(sections / 16));
  });

  it("prices five CPU idle tails at the audit's scaledown", () => {
    // Extract, a few master containers, and concat. ~$0.05 at 300s.
    const before = modelCpuIdleTails(5, 300);
    const after = modelCpuIdleTails(5, CPU_SCALEDOWN_DEFAULT_S);
    expect(CPU_SCALEDOWN_DEFAULT_S).toBe(10);
    expect(before.usd).toBeGreaterThan(0.045);
    expect(before.usd).toBeLessThan(0.06);
    expect(after.usd).toBeCloseTo(before.usd * (CPU_SCALEDOWN_DEFAULT_S / 300), 6);
    expect(cpuAppUsdPerSecond()).toBeGreaterThan(0);
  });
});
