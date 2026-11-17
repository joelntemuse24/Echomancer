import { describe, expect, it, beforeEach } from "vitest";
import {
  admitRemoteCall,
  everyStartHasAnEnd,
  executeDrain,
  haltBook,
  interpretCancelResult,
  isBookHalted,
  modalAppRegistry,
  planDrain,
  planHealthCheck,
  planWatchdog,
  resetRemoteLayerForTests,
  runRemoteCall,
  RemoteCallRefused,
} from "@/lib/remote/layer";
import { REMOTE_PROVIDERS } from "@/lib/remote/types";

beforeEach(() => {
  resetRemoteLayerForTests();
});

describe("remote call invariants", () => {
  it("never has two in-flight calls for the same section", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = runRemoteCall({
      provider: "s2-clone",
      path: "book",
      jobId: "book-1",
      sections: ["0"],
      execute: () => gate.then(() => "audio"),
    });
    await Promise.resolve();
    const second = runRemoteCall({
      provider: "s2-clone",
      path: "book",
      jobId: "book-1",
      sections: ["0"],
      execute: async () => "second",
    });
    const blocked = admitRemoteCall({
      provider: "s2-clone",
      path: "book",
      jobId: "book-1",
      sections: ["0", "1"],
    });
    expect(blocked.kind).toBe("blocked");
    release?.();
    await expect(first).resolves.toBe("audio");
    await expect(second).resolves.toBe("audio");
    expect(everyStartHasAnEnd()).toBe(true);
  });

  it("a cancelled book produces zero new calls on every provider", async () => {
    haltBook("book-9", "cancelled");
    expect(isBookHalted("book-9")).toBe(true);
    for (const provider of REMOTE_PROVIDERS) {
      let ran = false;
      await expect(
        runRemoteCall({
          provider,
          path: "book",
          jobId: "book-9",
          sections: ["0"],
          execute: async () => {
            ran = true;
            return "nope";
          },
        })
      ).rejects.toBeInstanceOf(RemoteCallRefused);
      expect(ran).toBe(false);
    }
  });

  it("every started call ends in a recorded state", async () => {
    await runRemoteCall({
      provider: "fish",
      path: "book",
      jobId: "book-2",
      sections: ["3"],
      execute: async () => "ok",
    });
    await expect(
      runRemoteCall({
        provider: "kokoro",
        path: "book",
        jobId: "book-2",
        sections: ["4"],
        timeoutMs: 5,
        execute: () => new Promise(() => {}),
      })
    ).rejects.toThrow();
    expect(everyStartHasAnEnd()).toBe(true);
  });

  it("treats NotFound and a non-terminal status as still live", () => {
    expect(interpretCancelResult({ threw: "NotFoundError: gone" })).toBe("still_live");
    expect(interpretCancelResult({ status: "pending" })).toBe("still_live");
    expect(interpretCancelResult({ status: "" })).toBe("still_live");
    expect(interpretCancelResult({ status: "terminated" })).toBe("terminal");
  });

  it("drains by cancel, then brake, then confirm, then restore with min 0", async () => {
    const steps = planDrain(1);
    expect(steps.map((step) => step.step)).toEqual([
      "cancel_pending",
      "brake_autoscaler",
      "confirm_zero_containers",
      "restore_autoscaler",
    ]);
    expect(steps.some((step) => "step" in step && String(step.step).includes("container-stop"))).toBe(
      false
    );
    for (const step of steps) {
      if ("minContainers" in step) expect(step.minContainers).toBe(0);
    }
    const order: string[] = [];
    const report = await executeDrain(
      { app: "echomancer-s2-clone", jobId: "book-3", callIds: ["fc-1"] },
      {
        cancel: async () => {
          order.push("cancel");
          return { threw: "NotFound" };
        },
        brake: async () => {
          order.push("brake");
        },
        runningContainers: async () => {
          order.push("count");
          return 0;
        },
        restore: async () => {
          order.push("restore");
        },
      },
      1
    );
    expect(order).toEqual(["cancel", "brake", "count", "restore"]);
    expect(report.stillLive).toEqual(["fc-1"]);
    expect(report.steps[3]).toMatchObject({ minContainers: 0 });
  });

  it("keeps min_containers at 0 and brakes an app with no owning job", () => {
    for (const app of modalAppRegistry()) {
      expect(app.minContainers).toBe(0);
      const over = planWatchdog({
        app,
        runningContainers: 1,
        owningJobIds: [],
        dailySpendUsd: 0,
        dailyCapUsd: 80,
      });
      expect(over).toMatchObject({ action: "brake", minContainers: 0, maxContainers: 0 });
    }
    const s2 = modalAppRegistry()[0]!;
    expect(
      planHealthCheck({ app: s2, restoreMs: 20_000, alreadySpentMs: 0, graphs: "ok(24)" }).action
    ).toBe("ok");
    expect(planHealthCheck({ app: s2, restoreMs: 120_000, alreadySpentMs: 0 }).action).toBe(
      "rewarm"
    );
    expect(
      planHealthCheck({ app: s2, restoreMs: null, alreadySpentMs: s2.healthDailyBudgetMs }).action
    ).toBe("skip");
  });
});
