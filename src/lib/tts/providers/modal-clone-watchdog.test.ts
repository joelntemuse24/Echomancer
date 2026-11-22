/**
 * The 2026-11-22 stall, as a rule.
 *
 * Book `f452bc31` had a restored container, a fresh `/ready` heartbeat, and
 * `POST /` answering 200 every three seconds. That 200 was the CPU control
 * endpoint's `pending` poll. The GPU never rendered the opening section, the
 * worker's own log went quiet, and the job row stayed `processing` until
 * somebody cancelled it by hand.
 *
 * These tests pin the two halves of the fix:
 *
 *   - a book with no audio and a *proven-restored* container trips a bounded
 *     clock, with a message that says what happened; and
 *   - a book waiting on a pool that never restored does **not** trip, because
 *     that is a cold queue with its own (documented) parking behaviour.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  firstAudioTimeoutLog,
  firstAudioTimeoutMessage,
  firstAudioWatchdog,
  modalCloneFirstAudioBudgetMs,
  raceFirstAudio,
  MODAL_CLONE_FIRST_AUDIO_DEFAULT_MS,
  MODAL_CLONE_FIRST_AUDIO_MAX_MS,
  MODAL_CLONE_FIRST_AUDIO_MIN_MS,
} from "@/lib/tts/providers/modal-clone-watchdog";
import { modalCloneFirstLightWaitMs } from "@/lib/tts/providers/modal-clone-guard";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("the first-audio budget", () => {
  it("defaults to 240s: a restore, the opening, and a slow placement", () => {
    expect(modalCloneFirstAudioBudgetMs({})).toBe(MODAL_CLONE_FIRST_AUDIO_DEFAULT_MS);
    expect(MODAL_CLONE_FIRST_AUDIO_DEFAULT_MS).toBe(240_000);
  });

  it("can never be shorter than the first-light wait it must not cut", () => {
    // The first-light wait is legitimate work. A budget below it would abort
    // a healthy cold opening, which is worse than the stall it is fixing.
    expect(modalCloneFirstAudioBudgetMs({ MODAL_S2_FIRST_AUDIO_MS: "1000" })).toBe(
      MODAL_CLONE_FIRST_AUDIO_MIN_MS
    );
    expect(MODAL_CLONE_FIRST_AUDIO_MIN_MS).toBeGreaterThanOrEqual(
      modalCloneFirstLightWaitMs({})
    );
  });

  it("clamps a huge value and falls back on nonsense", () => {
    expect(modalCloneFirstAudioBudgetMs({ MODAL_S2_FIRST_AUDIO_MS: "99999999" })).toBe(
      MODAL_CLONE_FIRST_AUDIO_MAX_MS
    );
    expect(modalCloneFirstAudioBudgetMs({ MODAL_S2_FIRST_AUDIO_MS: "abc" })).toBe(
      MODAL_CLONE_FIRST_AUDIO_DEFAULT_MS
    );
    expect(modalCloneFirstAudioBudgetMs({ MODAL_S2_FIRST_AUDIO_MS: "-5" })).toBe(
      MODAL_CLONE_FIRST_AUDIO_DEFAULT_MS
    );
  });

  it("MODAL_S2_FIRST_AUDIO_MS=0 is the rollback", () => {
    expect(modalCloneFirstAudioBudgetMs({ MODAL_S2_FIRST_AUDIO_MS: "0" })).toBe(0);
    expect(
      firstAudioWatchdog({
        startedAt: 0,
        now: 10 * 60_000,
        budgetMs: 0,
      })
    ).toEqual({ trip: false, reason: "disabled" });
  });
});

describe("the trip decision", () => {
  it("does not trip inside the budget", () => {
    expect(
      firstAudioWatchdog({ startedAt: 1_000, now: 2_000, budgetMs: 240_000 })
    ).toEqual({ trip: false, reason: "within_budget" });
  });

  it("trips once the budget is spent with no audio", () => {
    const verdict = firstAudioWatchdog({
      startedAt: 0,
      now: 240_001,
      budgetMs: 240_000,
    });
    expect(verdict.trip).toBe(true);
    if (!verdict.trip) throw new Error("expected a trip");
    expect(verdict.elapsedMs).toBe(240_001);
    expect(verdict.message).toContain("produced no audio");
  });

  it("never trips a book that already has audio", () => {
    // Later calls are covered by the warm HTTP budget. A warm container is
    // not compiling, so there is nothing for this clock to catch.
    expect(
      firstAudioWatchdog({
        firstAudioAt: Math.floor(Date.now() / 1000),
        startedAt: 0,
        now: 10 * 60_000,
        budgetMs: 1_000,
      })
    ).toEqual({ trip: false, reason: "has_audio" });
    expect(
      firstAudioWatchdog({
        hasAudio: true,
        startedAt: 0,
        now: 10 * 60_000,
        budgetMs: 1_000,
      })
    ).toEqual({ trip: false, reason: "has_audio" });
  });

  it("writes a message that names the wait, the limit, and the release", () => {
    const message = firstAudioTimeoutMessage(250_000, 240_000);
    expect(message).toContain("250s");
    expect(message).toContain("240s");
    expect(message).toContain("GPU was released");
    expect(message).toContain("stopped");
    // It must not invite the same dead wait again.
    expect(message.toLowerCase()).not.toContain("still starting");
  });

  it("logs the numbers an operator needs on one searchable line", () => {
    const line = firstAudioTimeoutLog({
      jobId: "f452bc31",
      elapsedMs: 251_000,
      budgetMs: 240_000,
      staged: 0,
      callId: "fc-abc",
    });
    expect(line).toContain("first-audio watchdog tripped");
    expect(line).toContain("f452bc31");
    expect(line).toContain("251s with no section");
    expect(line).toContain("limit 240s");
    expect(line).toContain("staged=0");
    expect(line).toContain("call=fc-abc");
  });
});

describe("racing the first call", () => {
  it("returns the call's result when audio lands in time", async () => {
    const result = await raceFirstAudio({
      run: async () => "take",
      probe: async () => ({ ready: true, warmContainers: 1 }),
      startedAt: Date.now(),
      hasAudio: false,
      budgetMs: 60_000,
      pollMs: 5_000,
    });
    expect(result).toEqual({ ok: true, value: "take" });
  });

  it("trips a restored container that never renders", async () => {
    // This is the incident: ready, warm, and silent forever.
    let release: (value: string) => void = () => {};
    const never = new Promise<string>((resolve) => {
      release = resolve;
    });
    const result = await raceFirstAudio({
      run: () => never,
      probe: async () => ({ ready: true, warmContainers: 1 }),
      startedAt: 0,
      hasAudio: false,
      budgetMs: 100_000,
      pollMs: 1_000,
      now: () => 100_001,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a trip");
    expect(result.sawReady).toBe(true);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(100_000);
    release("late");
  });

  it("does not trip a pool that never restored", async () => {
    // Modal had no capacity. That is a cold queue, which parks and then takes
    // the documented fallback. Failing the book here would turn a queue into
    // a lost book.
    let release: (value: string) => void = () => {};
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const race = raceFirstAudio({
      run: () => pending,
      probe: async () => ({ ready: false, warmContainers: 0 }),
      startedAt: 0,
      hasAudio: false,
      budgetMs: 10_000,
      pollMs: 1_000,
      now: () => 60_000,
    });
    // Give the race a couple of poll ticks.
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    release("eventually");
    await expect(race).resolves.toEqual({ ok: true, value: "eventually" });
  });

  it("latches readiness seen before the clock ran out", async () => {
    // The container restored at 5s and then went silent. Readiness must not
    // have to still be true at the moment the budget expires.
    let tick = 0;
    const result = await raceFirstAudio({
      run: () => new Promise<string>(() => undefined),
      probe: async () => {
        tick += 1;
        return tick === 1
          ? { ready: true, warmContainers: 1 }
          : { ready: false, warmContainers: 0 };
      },
      startedAt: 0,
      hasAudio: false,
      budgetMs: 100_000,
      pollMs: 1_000,
      now: () => 100_001,
    });
    expect(result.ok).toBe(false);
  });

  it("hands back the call's own error untouched", async () => {
    await expect(
      raceFirstAudio({
        run: async () => {
          throw new Error("provider fault");
        },
        probe: async () => ({ ready: true, warmContainers: 1 }),
        startedAt: Date.now(),
        hasAudio: false,
        budgetMs: 60_000,
      })
    ).rejects.toThrow("provider fault");
  });

  it("does not start the clock for a book that already has audio", async () => {
    const probe = vi.fn(async () => ({ ready: true, warmContainers: 1 }));
    const result = await raceFirstAudio({
      run: async () => "second call",
      probe,
      startedAt: 0,
      hasAudio: true,
      budgetMs: 1_000,
      now: () => 10 * 60_000,
    });
    expect(result).toEqual({ ok: true, value: "second call" });
    expect(probe).not.toHaveBeenCalled();
  });
});
