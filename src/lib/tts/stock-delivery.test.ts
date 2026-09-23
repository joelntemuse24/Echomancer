import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UX } from "@/lib/ux-copy";
import {
  expressiveChoiceEnabled,
  showExpressiveChoice,
  stockDeliveryLabel,
} from "./stock-delivery";

function sourceOf(path: string): string {
  return readFileSync(path, "utf8");
}

describe("stock delivery choice", () => {
  it("labels Expressive in parentheses and hides it until a reference is wired", () => {
    expect(stockDeliveryLabel("Andrew", "standard")).toBe("Andrew");
    expect(stockDeliveryLabel("Andrew", "expressive")).toBe(
      "Andrew (Expressive)"
    );
    expect(stockDeliveryLabel("Michelle (Expressive)", "expressive")).toBe(
      "Michelle (Expressive)"
    );
    expect(stockDeliveryLabel("Randolph", "expressive")).toBe(
      "Randolph (Expressive)"
    );
    expect(showExpressiveChoice(null)).toBe(false);
    expect(showExpressiveChoice({ configured: false, available: false })).toBe(
      false
    );
    expect(showExpressiveChoice({ configured: true, available: false })).toBe(
      true
    );
    expect(expressiveChoiceEnabled({ configured: true, available: false })).toBe(
      false
    );
    expect(expressiveChoiceEnabled({ configured: true, available: true })).toBe(
      true
    );
    expect(UX.playBoth).toBe("Play both");
    expect(UX.expressiveUnavailable).toMatch(/not available yet/i);
    expect(`${UX.playBoth} ${UX.expressiveUnavailable}`).not.toMatch(
      /fish|edge|google|deepseek/i
    );
  });

  it("offers play-both on the voice step without starting a book", () => {
    const voicePage = sourceOf("src/app/dashboard/voice/page.tsx");
    expect(voicePage).toContain("showExpressiveChoice");
    expect(voicePage).toContain("UX.playBoth");
    expect(voicePage).toContain("UX.expressiveUnavailable");
    expect(voicePage).toContain(
      'loadServerPreview(voice, "standard", "compare")'
    );
    expect(voicePage).toContain(
      'loadServerPreview(voice, "expressive", "compare")'
    );
    expect(voicePage).not.toContain(
      'loadServerPreview(voice, "expressive", "preview")'
    );
    expect(voicePage).not.toContain("NarrationDeliveryControls");
    expect(voicePage).not.toContain("UX.narrationDelivery");
    expect(voicePage).toContain("stockDelivery");
    expect(voicePage).toMatch(/createStockJob\(selectedVoice\)/);
    expect(voicePage).not.toMatch(/createStockJob\(voice\)/);
    expect(voicePage.match(/createStockJob\(selectedVoice\)/g)?.length).toBe(1);
  });
});
