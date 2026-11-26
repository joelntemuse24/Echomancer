import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bookSpend, remoteEvents, resetRemoteLayerForTests } from "@/lib/remote/layer";
import { resetModalWorkspaceDisabled, ModalWorkspaceDisabledError } from "@/lib/modal/workspace-disabled";
import {
  KOKORO_AUDIO_SECONDS_PER_CHAR,
  KOKORO_USD_PER_AUDIO_HOUR,
  kokoroRemoteEstimate,
} from "@/lib/tts/kokoro-remote";

const DISABLED = "modal-http: workspace ac-secret is disabled";

beforeEach(() => {
  resetRemoteLayerForTests();
  resetModalWorkspaceDisabled();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetModalWorkspaceDisabled();
  delete process.env.DREW_ENABLED;
  delete process.env.DREW_URL;
  delete process.env.DREW_TOKEN;
  delete process.env.GEORGE_ENABLED;
  delete process.env.GEORGE_URL;
  delete process.env.GEORGE_TOKEN;
  delete process.env.HEART_ENABLED;
  delete process.env.HEART_URL;
  delete process.env.HEART_TOKEN;
  delete process.env.SOWELL_ENABLED;
  delete process.env.SOWELL_URL;
  delete process.env.SOWELL_TOKEN;
});

describe("kokoro remote estimate", () => {
  it("prices audio, not a flat cent, and stays under the book cap", () => {
    const one = kokoroRemoteEstimate(350);
    const seconds = 350 * KOKORO_AUDIO_SECONDS_PER_CHAR;
    expect(one.estMs).toBe(Math.round(seconds * 1000));
    expect(one.estCostUsd).toBeCloseTo((seconds / 3600) * KOKORO_USD_PER_AUDIO_HOUR, 8);
    expect(one.estCostUsd).toBeLessThan(0.01);

    const sections = 2000;
    const typical = sections * kokoroRemoteEstimate(350).estCostUsd;
    const widest = sections * kokoroRemoteEstimate(2000).estCostUsd;
    expect(typical).toBeGreaterThan(1);
    expect(typical).toBeLessThan(2);
    expect(widest).toBeLessThan(10);
    expect(widest).toBeLessThan(20);
  });
});

describe("kokoro platform refusals", () => {
  it.each([
    ["drew", "DREW_ENABLED", "DREW_URL", "DREW_TOKEN"],
    ["george", "GEORGE_ENABLED", "GEORGE_URL", "GEORGE_TOKEN"],
    ["heart", "HEART_ENABLED", "HEART_URL", "HEART_TOKEN"],
    ["sowell", "SOWELL_ENABLED", "SOWELL_URL", "SOWELL_TOKEN"],
  ] as const)("%s records a workspace 404 as a failure with no reservation", async (id, enabledKey, urlKey, tokenKey) => {
    process.env[enabledKey] = "1";
    process.env[urlKey] = "https://kokoro.example";
    process.env[tokenKey] = "token";
    const text = "The harbor was quiet after the rain.";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(DISABLED, { status: 404 }))
    );
    const adapter =
      id === "drew"
        ? (await import("@/lib/tts/providers/drew")).drewTtsProvider
        : id === "george"
          ? (await import("@/lib/tts/providers/george")).georgeTtsProvider
          : id === "heart"
            ? (await import("@/lib/tts/providers/heart")).heartTtsProvider
            : (await import("@/lib/tts/providers/sowell")).sowellTtsProvider;
    await expect(
      adapter.synthesize({ text, voiceId: id, jobId: `job-${id}`, sectionIndex: 3 })
    ).rejects.toBeInstanceOf(ModalWorkspaceDisabledError);

    const events = remoteEvents();
    expect(events.some((event) => event.outcome === "success")).toBe(false);
    expect(events.some((event) => event.outcome === "failure")).toBe(true);
    expect(bookSpend(`job-${id}`).usd).toBe(0);
    const started = events.find((event) => event.outcome === "started");
    expect(started?.estCostUsd).toBeCloseTo(kokoroRemoteEstimate(text.length).estCostUsd, 8);

    await expect(
      adapter.synthesize({ text, voiceId: id, jobId: `job-${id}`, sectionIndex: 4 })
    ).rejects.toBeInstanceOf(ModalWorkspaceDisabledError);
    expect(remoteEvents().filter((event) => event.outcome === "started")).toHaveLength(1);
  });

  it("records an application 500 as a failure and keeps the estimate", async () => {
    process.env.DREW_ENABLED = "1";
    process.env.DREW_URL = "https://kokoro.example";
    process.env.DREW_TOKEN = "token";
    const text = "The harbor was quiet after the rain.";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("spoken text does not match the request", { status: 500 }))
    );
    const { drewTtsProvider } = await import("@/lib/tts/providers/drew");
    await expect(
      drewTtsProvider.synthesize({ text, voiceId: "drew", jobId: "job-app", sectionIndex: 5 })
    ).rejects.toThrow(/spoken text does not match/);
    expect(remoteEvents().some((event) => event.outcome === "success")).toBe(false);
    expect(remoteEvents().some((event) => event.outcome === "failure")).toBe(true);
    expect(bookSpend("job-app").usd).toBeCloseTo(kokoroRemoteEstimate(text.length).estCostUsd, 8);
  });
});
