import { describe, expect, it } from "vitest";
import {
  expressiveChoiceEnabled,
  showExpressiveChoice,
  stockDeliveryLabel,
} from "./stock-delivery";

describe("stock delivery choice", () => {
  it("hides Expressive until a reference is wired and keeps it disabled while the gate is closed", () => {
    expect(stockDeliveryLabel("Andrew", "expressive")).toBe(
      "Andrew (Expressive)"
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
  });
});
