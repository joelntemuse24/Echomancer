/**
 * Rollout safety for the 32-row page.
 *
 * The worker and the Modal app ship separately, and the Modal app takes a
 * 15-minute snapshot rebuild. So there is a window where this worker is running
 * against the **live v9 container**, which accepts at most 24 rows and returns
 * inline base64. A worker that planned 32 rows there would collect
 * `422 batch_too_large` on every full page and lose the section.
 *
 * The rule these tests pin: 32 rows require **both** facts, each reported by
 * `/ready` — `audio_transport: "r2"` and `max_batch_items >= 32`. Anything less
 * keeps the v9 ceiling.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MODAL_CLONE_INLINE_BATCH_ROWS,
  MODAL_CLONE_MAX_BATCH_ROWS,
  modalCloneAudioTransport,
  modalCloneBatchRowsForTransport,
  modalCloneReportedMaxBatchItems,
  noteModalCloneAudioTransport,
  noteModalCloneMaxBatchItems,
  resetModalCloneAudioTransportForTests,
} from "./modal-clone-transport";
import { modalCloneBatchItems } from "./modal-clone-guard";

afterEach(() => {
  resetModalCloneAudioTransportForTests();
  vi.unstubAllEnvs();
});

describe("clone batch rollout gating", () => {
  it("starts at the live container's ceiling, not the new one", () => {
    expect(MODAL_CLONE_INLINE_BATCH_ROWS).toBe(24);
    expect(MODAL_CLONE_MAX_BATCH_ROWS).toBe(32);
    expect(modalCloneAudioTransport({} as NodeJS.ProcessEnv)).toBe("inline");
    expect(modalCloneReportedMaxBatchItems()).toBe(0);
  });

  it("needs both an r2 transport and a 32-row cap before it widens", () => {
    vi.stubEnv("MODAL_S2_BATCH_SIZE", "");
    const env = process.env;

    expect(modalCloneBatchRowsForTransport(env)).toBe(24);

    // r2 alone is not enough: an r2 build could still cap rows at 24.
    noteModalCloneAudioTransport("r2");
    expect(modalCloneBatchRowsForTransport(env)).toBe(24);

    // The cap alone is not enough either: inline rows hit the 80 MiB body.
    noteModalCloneMaxBatchItems(32);
    resetModalCloneAudioTransportForTests();
    noteModalCloneMaxBatchItems(32);
    expect(modalCloneBatchRowsForTransport(env)).toBe(24);

    // Both: the page may be 32 rows.
    noteModalCloneAudioTransport("r2");
    expect(modalCloneBatchRowsForTransport(env)).toBe(32);
  });

  it("never widens past the container's own cap", () => {
    vi.stubEnv("MODAL_S2_BATCH_SIZE", "");
    noteModalCloneAudioTransport("r2");
    noteModalCloneMaxBatchItems(24);
    expect(modalCloneBatchRowsForTransport(process.env)).toBe(24);
    noteModalCloneMaxBatchItems(16);
    expect(modalCloneBatchRowsForTransport(process.env)).toBe(24);
  });

  it("treats a missing or malformed cap as no cap", () => {
    noteModalCloneMaxBatchItems(undefined);
    expect(modalCloneReportedMaxBatchItems()).toBe(0);
    noteModalCloneMaxBatchItems("junk");
    expect(modalCloneReportedMaxBatchItems()).toBe(0);
    noteModalCloneMaxBatchItems(-4);
    expect(modalCloneReportedMaxBatchItems()).toBe(0);
    // And a cap above the tensor capacity is clamped to it.
    noteModalCloneMaxBatchItems(999);
    expect(modalCloneReportedMaxBatchItems()).toBe(32);
  });

  it("an explicit page size still wins, clamped to the capacity", () => {
    vi.stubEnv("MODAL_S2_BATCH_SIZE", "12");
    expect(modalCloneBatchItems()).toBe(12);
    vi.stubEnv("MODAL_S2_BATCH_SIZE", "999");
    expect(modalCloneBatchItems()).toBe(32);
    vi.stubEnv("MODAL_S2_BATCH_SIZE", "0");
    // 0 is not usable, so the reported state decides.
    expect(modalCloneBatchItems()).toBe(24);
  });

  it("an explicit transport pin overrides the probe", () => {
    noteModalCloneAudioTransport("inline");
    vi.stubEnv("MODAL_S2_AUDIO_TRANSPORT", "r2");
    expect(modalCloneAudioTransport(process.env)).toBe("r2");
    vi.stubEnv("MODAL_S2_AUDIO_TRANSPORT", "inline");
    expect(modalCloneAudioTransport(process.env)).toBe("inline");
  });
});
