import { describe, expect, it } from "vitest";
import { resolveStockSelection } from "@/lib/stock-voice-pick";
import {
  rowIsPressed,
  submittedVoiceId,
  voiceIdAfterRowAction,
  type VoiceRowKind,
} from "./voice-row-selection";

const rows: Array<{ id: string; kind: VoiceRowKind }> = [
  { id: "ava", kind: "stock" },
  { id: "libby", kind: "stock" },
  { id: "echomancer-andrew", kind: "stock" },
  { id: "drew", kind: "kokoro" },
  { id: "george", kind: "kokoro" },
  { id: "sowell", kind: "kokoro" },
  { id: "clone:abc", kind: "clone" },
];

describe("voice row selection", () => {
  it("submits the voice that preview pressed, for every row type", () => {
    for (const row of rows) {
      const selected = voiceIdAfterRowAction({
        action: "preview",
        voiceId: row.id,
        selectedId: "drew",
        kind: row.kind,
      });
      expect(rowIsPressed(selected, row.id)).toBe(true);
      expect(submittedVoiceId(selected)).toBe(row.id);
      for (const other of rows) {
        if (other.id === row.id) continue;
        expect(rowIsPressed(selected, other.id)).toBe(false);
      }
    }
  });

  it("does not move the selection when a preview is stopped", () => {
    const selected = voiceIdAfterRowAction({
      action: "stop-preview",
      voiceId: "sowell",
      selectedId: "drew",
      kind: "kokoro",
    });
    expect(submittedVoiceId(selected)).toBe("drew");
    expect(rowIsPressed(selected, "sowell")).toBe(false);
    expect(rowIsPressed(selected, "drew")).toBe(true);
  });

  it("presses Drew on a fresh load, and keeps Walter pressed after it was previewed", () => {
    const ids = ["drew", "echomancer-andrew", "ava", "libby", "george", "sowell"];
    const fresh = resolveStockSelection({
      availableIds: ids,
      explicitId: null,
      suggestedId: null,
    });
    expect(fresh).toBe("drew");
    expect(rowIsPressed(fresh, "drew")).toBe(true);
    expect(rowIsPressed(fresh, "sowell")).toBe(false);
    expect(submittedVoiceId(fresh)).toBe("drew");

    const afterPreview = voiceIdAfterRowAction({
      action: "preview",
      voiceId: "sowell",
      selectedId: fresh,
      kind: "kokoro",
    });
    const reloaded = resolveStockSelection({
      availableIds: ids,
      explicitId: afterPreview,
      suggestedId: "drew",
    });
    expect(reloaded).toBe("sowell");
    expect(rowIsPressed(reloaded, "sowell")).toBe(true);
    expect(submittedVoiceId(reloaded)).toBe("sowell");
  });
});
