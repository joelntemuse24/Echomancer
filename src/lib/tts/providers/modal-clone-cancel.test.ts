import { afterEach, describe, expect, it } from "vitest";
import {
  cancelAbandonedModalCallsAfterAbort,
  mayCancelAbandonedModalCall,
  modalCloneCancelConfigured,
  resetModalCloneCancelForTests,
  setModalCloneCallCancellerForTests,
} from "./modal-clone-cancel";

afterEach(() => {
  resetModalCloneCancelForTests();
});

describe("mayCancelAbandonedModalCall", () => {
  it("cancels only unstarted pending leftovers", () => {
    expect(
      mayCancelAbandonedModalCall({ status: "pending", started_at: null })
    ).toBe(true);
    expect(mayCancelAbandonedModalCall({ status: "PENDING" })).toBe(true);
    expect(mayCancelAbandonedModalCall({ status: "0" })).toBe(true);
  });

  it("refuses to cancel a call that has already started enter or compile", () => {
    expect(
      mayCancelAbandonedModalCall({
        status: "pending",
        started_at: "2026-11-12T05:32:48Z",
        container_id: "ta-compiling",
      })
    ).toBe(false);
  });

  it("refuses to cancel terminal inputs", () => {
    expect(
      mayCancelAbandonedModalCall({
        status: "success",
        started_at: "2026-11-12T05:44:48Z",
      })
    ).toBe(false);
    expect(mayCancelAbandonedModalCall({ status: "failure" })).toBe(false);
    expect(mayCancelAbandonedModalCall({ status: "terminated" })).toBe(false);
  });
});

describe("cancelAbandonedModalCallsAfterAbort", () => {
  it("is disabled without Modal credentials", () => {
    const previousId = process.env.MODAL_TOKEN_ID;
    const previousSecret = process.env.MODAL_TOKEN_SECRET;
    delete process.env.MODAL_TOKEN_ID;
    delete process.env.MODAL_TOKEN_SECRET;
    delete process.env.MODAL_S2_CANCEL_CMD;
    try {
      expect(modalCloneCancelConfigured()).toBe(false);
    } finally {
      if (previousId !== undefined) process.env.MODAL_TOKEN_ID = previousId;
      if (previousSecret !== undefined) process.env.MODAL_TOKEN_SECRET = previousSecret;
    }
  });

  it("invokes the hook and swallows hook failures", () => {
    const seen: string[] = [];
    setModalCloneCallCancellerForTests((opts) => {
      seen.push(opts.reason ?? "");
      return true;
    });
    expect(
      cancelAbandonedModalCallsAfterAbort({ reason: "first-light wait aborted" })
    ).toBe(true);
    expect(seen).toEqual(["first-light wait aborted"]);

    setModalCloneCallCancellerForTests(() => {
      throw new Error("spawn failed");
    });
    expect(cancelAbandonedModalCallsAfterAbort({ reason: "abort" })).toBe(false);
  });
});
