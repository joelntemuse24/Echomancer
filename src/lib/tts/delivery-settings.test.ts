import { describe, expect, it } from "vitest";
import {
  adaptDeliverySettings,
  resolveDeliverySettings,
} from "./delivery-settings";

const DENSE = [
  "Abstract",
  "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. The best performing models also connect the encoder and decoder through an attention mechanism.",
].join("\n\n");

const CONVERSATIONAL = [
  '"Hello," he said.',
  '"Are you sure?" she asked.',
  '"Yes," he said, and they walked on.',
].join("\n\n");

describe("adaptDeliverySettings", () => {
  it("uses normal pauses and a delivery cue on dense long sentences", () => {
    const adapted = adaptDeliverySettings(DENSE);
    expect(adapted.pauseStyle).toBe("normal");
    expect(adapted.deliveryPrefix).toBe(true);
    expect(adapted.source.pauseStyle).toBe("adaptive");
  });

  it("uses sparse pauses and skips the anti-read cue on short dialogue", () => {
    const adapted = adaptDeliverySettings(CONVERSATIONAL);
    expect(adapted.pauseStyle).toBe("sparse");
    expect(adapted.deliveryPrefix).toBe(false);
  });

  it("turns title cleanup on when ALL-CAPS headings or Roman sections appear", () => {
    const adapted = adaptDeliverySettings(
      "THE TWO CITIES\n\nII\n\nThe river was wide and the night was long."
    );
    expect(adapted.normalizeTitles).toBe(true);
  });

  it("shortens the join window on a short chapter", () => {
    expect(adaptDeliverySettings("A short chapter. ").crossfadeMs).toBe(80);
  });

  it("keeps the default 120ms join on a typical-length extract", () => {
    expect(adaptDeliverySettings("A sentence. ".repeat(400)).crossfadeMs).toBe(
      120
    );
  });
});

describe("resolveDeliverySettings", () => {
  it("lets the user pin sparse pauses and an explicit join", () => {
    const resolved = resolveDeliverySettings(DENSE, {
      pauseStyle: "sparse",
      crossfadeMs: 150,
      normalizeTitles: false,
      deliveryPrefix: false,
    });
    expect(resolved.pauseStyle).toBe("sparse");
    expect(resolved.crossfadeMs).toBe(150);
    expect(resolved.normalizeTitles).toBe(false);
    expect(resolved.deliveryPrefix).toBe(false);
    expect(resolved.source.pauseStyle).toBe("user");
    expect(resolved.source.crossfadeMs).toBe("user");
  });

  it("treats auto as adaptive", () => {
    const resolved = resolveDeliverySettings(DENSE, { pauseStyle: "auto" });
    expect(resolved.pauseStyle).toBe("normal");
    expect(resolved.source.pauseStyle).toBe("adaptive");
  });
});
