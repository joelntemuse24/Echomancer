import { describe, expect, it } from "vitest";
import { acceptJobPoll, commitUserStop, generationStatus } from "./generation-status";

const providers = ["drew", "george", "sowell", "fish", "modal", "edge"] as const;

describe("generationStatus", () => {
  it("uses the same section ratio for Kokoro, Fish, and S2", () => {
    const lines = providers.map((provider) =>
      generationStatus({
        status: "processing",
        provider,
        currentSection: 1,
        totalSections: 20,
        etaLabel: "under a minute",
        etaState: "live",
        segments: [
          { status: "ready", path: "audiobooks/j/sections/0000.mp3" },
          { status: "pending", path: "" },
        ],
      })
    );
    expect(new Set(lines.map((view) => view.line)).size).toBe(1);
    const view = lines[0]!;
    expect(view.percent).toBe(5);
    expect(view.line).toBe("1 of 20 · 5% · under a minute left");
    expect(view.line).not.toContain("99%");
    expect(view.showStop).toBe(true);
    expect(view.phase).toBe("running");
  });

  it("says the book is finishing when every section is stored and the join is still running", () => {
    const view = generationStatus({
      status: "processing",
      currentSection: 1,
      totalSections: 1,
      etaLabel: "under a minute",
      etaState: "finalizing",
      segments: [{ status: "ready", path: "audiobooks/j/sections/0000.mp3" }],
    });
    expect(view.phase).toBe("finishing");
    expect(view.line).toBe("Finishing… · under a minute left");
    expect(view.meterLabel).toBe("Finishing…");
    expect(view.line).not.toContain("99%");
    expect(view.showStop).toBe(true);
  });

  it("shows a duration once the outline is known, and Estimating only when it is not", () => {
    const waiting = generationStatus({
      status: "queued",
      totalSections: 0,
      currentSection: 0,
      etaLabel: "Estimating…",
      etaState: "estimating",
    });
    expect(waiting.line).toBe("Estimating…");
    expect(waiting.percent).toBeNull();
    expect(waiting.showStop).toBe(true);

    const outlined = generationStatus({
      status: "processing",
      totalSections: 24,
      currentSection: 0,
      etaLabel: "~6 min",
      etaState: "estimating",
    });
    expect(outlined.line).toBe("0 of 24 · 0% · ~6 min left");
    expect(outlined.percent).toBe(0);
  });

  it("hides Stop on a terminal book and says Stopped after cancel", () => {
    for (const status of ["ready", "failed", "cancelled"] as const) {
      const view = generationStatus({ status, totalSections: 8, currentSection: 3 });
      expect(view.showStop).toBe(false);
    }
    const stopped = generationStatus({
      status: "cancelled",
      totalSections: 8,
      currentSection: 3,
      segments: [{ status: "ready", path: "audiobooks/j/sections/0000.mp3" }],
    });
    expect(stopped.phase).toBe("stopped");
    expect(stopped.line).toBe("Stopped");
    expect(stopped.showStop).toBe(false);
  });
});

describe("acceptJobPoll", () => {
  it("drops a stale generating body after the page has already stopped the book", () => {
    expect(acceptJobPoll("cancelled", "processing")).toBe(false);
    expect(acceptJobPoll("ready", "queued")).toBe(false);
    expect(acceptJobPoll("failed", "waiting")).toBe(false);
    expect(acceptJobPoll("cancelled", "cancelled")).toBe(true);
    expect(acceptJobPoll("processing", "cancelled")).toBe(true);
    expect(acceptJobPoll(null, "processing")).toBe(true);
  });

  it("writes the cancelled job onto the poll ref before the next paint", () => {
    const holder = {
      current: {
        status: "processing",
        error_message: null as string | null,
        current_section: 1,
      },
    };
    const next = commitUserStop(holder, holder.current);
    expect(holder.current).toBe(next);
    expect(holder.current.status).toBe("cancelled");
    expect(holder.current.error_message).toBe("Cancelled by user");
    expect(holder.current.current_section).toBe(1);
    expect(acceptJobPoll(holder.current.status, "processing")).toBe(false);
    expect(acceptJobPoll(holder.current.status, "queued")).toBe(false);
  });
});
