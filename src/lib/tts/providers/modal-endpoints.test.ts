/**
 * Endpoint URL construction.
 *
 * Staging found the smoke script and the worker client both building
 * `${baseUrl}/synthesize_batch` and `${baseUrl}/ready`, which 404 against a real
 * deploy. Modal serves each `@modal.fastapi_endpoint` at the root of **its own**
 * hostname, so one base plus routes is not a shape that exists. These tests
 * assert the request URLs exactly, so a regression cannot hide behind a mock
 * that happens to fake the old paths.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  modalBatchUrl,
  modalClonePoolReady,
  modalReadyUrl,
  modalSingleUrl,
  resetModalCloneRuntimeForTests,
  synthesizeModalClone,
} from "./modal-clone";
import {
  BATCH_HOST,
  READY_HOST,
  SINGLE_HOST,
  endpointOf,
  readyBody,
} from "./modal-endpoints.fixture";
import { queryOne } from "@/lib/turso";
import { downloadFile } from "@/lib/storage";

vi.mock("@/lib/turso", () => ({ queryOne: vi.fn(), execute: vi.fn() }));
vi.mock("@/lib/storage", () => ({ downloadFile: vi.fn() }));

const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0, 1]);

afterEach(() => {
  resetModalCloneRuntimeForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("endpoint resolution", () => {
  it("uses each endpoint's own host with nothing appended", () => {
    vi.stubEnv("MODAL_S2_TTS_URL", BATCH_HOST);
    vi.stubEnv("MODAL_S2_SYNTHESIZE_URL", SINGLE_HOST);
    vi.stubEnv("MODAL_S2_READY_URL", READY_HOST);

    expect(modalBatchUrl()).toBe(BATCH_HOST);
    expect(modalSingleUrl()).toBe(SINGLE_HOST);
    expect(modalReadyUrl()).toBe(READY_HOST);
    // The old shape must be impossible to produce.
    for (const url of [modalBatchUrl(), modalSingleUrl()!, modalReadyUrl()!]) {
      expect(url).not.toMatch(/\/(synthesize|synthesize_batch|ready)$/);
      expect(isOneOrigin(url)).toBe(true);
    }
  });

  it("does not derive a ready host from the batch host", () => {
    vi.stubEnv("MODAL_S2_TTS_URL", BATCH_HOST);
    vi.stubEnv("MODAL_S2_READY_URL", "");
    // There is no `/ready` route on the batch host, so the answer is "none",
    // never a guessed URL.
    expect(modalReadyUrl()).toBeNull();
  });

  it("rejects a URL that already carries a path", () => {
    vi.stubEnv("MODAL_S2_TTS_URL", `${BATCH_HOST}/synthesize_batch`);
    expect(() => modalBatchUrl()).toThrow(/bare Modal endpoint host/);
  });

  it("rejects a ready URL pointing at the batch host", () => {
    vi.stubEnv("MODAL_S2_TTS_URL", BATCH_HOST);
    vi.stubEnv("MODAL_S2_READY_URL", BATCH_HOST);
    expect(() => modalReadyUrl()).toThrow(/separate @modal\.fastapi_endpoint/);
  });

  it("never sends a single-section body to the batch host", () => {
    vi.stubEnv("MODAL_S2_TTS_URL", BATCH_HOST);
    vi.stubEnv("MODAL_S2_SYNTHESIZE_URL", "");
    // No single endpoint means "no single endpoint". It must not silently
    // become the batch host, because `{ text, … }` posted there is a
    // guaranteed 400 — and on 2026-11-06 it arrived only after a ~38s GPU
    // restore, so every first preview cost a cold start to earn a rejection.
    expect(modalSingleUrl()).toBeNull();
  });

  it("tolerates a trailing slash but not a path", () => {
    vi.stubEnv("MODAL_S2_TTS_URL", `${BATCH_HOST}/`);
    expect(modalBatchUrl()).toBe(BATCH_HOST);
  });

  it("rejects a relative URL instead of silently fetching it", () => {
    vi.stubEnv("MODAL_S2_TTS_URL", "acme--app-synthesize-batch.modal.run");
    expect(() => modalBatchUrl()).toThrow(/absolute http/);
  });
});

describe("requests go to the right host", () => {
  function setupFetch() {
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes("usage_logs")) return { user_chars: 0, global_chars: 0 };
      return {
        sample_storage_path: "clones/saved/sample.wav",
        reference_transcript: "the sample words",
        user_id: "user_a",
      };
    });
    vi.mocked(downloadFile).mockResolvedValue(Buffer.from("reference audio"));
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      // `/synthesize` answers with raw audio; `/synthesize_batch` answers JSON.
      if (endpointOf(String(url)) === "single") {
        return new Response(mp3, { headers: { "x-s2-duration": "42.5" } });
      }
      return new Response(
        JSON.stringify({
          items: [
            {
              key: "0",
              audio_b64: Buffer.from(mp3).toString("base64"),
              duration_s: 42.5,
              units: 3,
              truncated_units: 0,
            },
          ],
          build: "abc123def456",
          container_id: "c-1",
          boot: "restored",
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("posts the single section to its own host", async () => {
    vi.stubEnv("MODAL_S2_TTS_URL", BATCH_HOST);
    vi.stubEnv("MODAL_S2_SYNTHESIZE_URL", SINGLE_HOST);
    vi.stubEnv("MODAL_S2_READY", "0");
    vi.stubEnv("MODAL_S2_TOKEN", "test-token");
    const fetchMock = setupFetch();

    await synthesizeModalClone({
      text: "It is a truth universally acknowledged.",
      voiceId: "private-fish-id",
      catalogVoiceId: "clone:saved-id",
      model: "s2.1-pro-base",
    });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual([SINGLE_HOST]);
    expect(endpointOf(urls[0]!)).toBe("single");
  });

  it("renders a single section through a one-row batch when no single host exists", async () => {
    vi.stubEnv("MODAL_S2_TTS_URL", BATCH_HOST);
    vi.stubEnv("MODAL_S2_SYNTHESIZE_URL", "");
    vi.stubEnv("MODAL_S2_READY", "0");
    vi.stubEnv("MODAL_S2_TOKEN", "test-token");
    const fetchMock = setupFetch();

    const result = await synthesizeModalClone({
      text: "It is a truth universally acknowledged.",
      voiceId: "private-fish-id",
      catalogVoiceId: "clone:saved-id",
      model: "s2.1-pro-base",
    });

    // This is the production shape that broke: only the batch URL. The call
    // must use the batch *contract* — `{ items: [...] }` — rather than posting
    // a single-section body at the batch host, which the container rejects.
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.every((url) => endpointOf(url) !== "single")).toBe(true);
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body));
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].text).toBe("It is a truth universally acknowledged.");
    expect(body.reference_audio_base64).toBeTruthy();
    // And the one row is decoded back into normal audio.
    expect(result.audio.length).toBeGreaterThan(0);
    expect(result.contentType).toBe("audio/mpeg");
    expect(result.durationHintSeconds).toBe(42.5);
  });

  it("fails loudly when the batch answers a single-section request with an error row", async () => {
    vi.stubEnv("MODAL_S2_TTS_URL", BATCH_HOST);
    vi.stubEnv("MODAL_S2_SYNTHESIZE_URL", "");
    vi.stubEnv("MODAL_S2_READY", "0");
    vi.stubEnv("MODAL_S2_TOKEN", "test-token");
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes("usage_logs")) return { user_chars: 0, global_chars: 0 };
      return {
        sample_storage_path: "clones/saved/sample.wav",
        reference_transcript: "the sample words",
        user_id: "user_a",
      };
    });
    vi.mocked(downloadFile).mockResolvedValue(Buffer.from("reference audio"));
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              items: [
                { key: "single", error: "reference_audio_base64 is required", error_code: "request_invalid" },
              ],
            }),
            { headers: { "Content-Type": "application/json" } }
          )
      )
    );

    await expect(
      synthesizeModalClone({
        text: "One line.",
        voiceId: "private-fish-id",
        catalogVoiceId: "clone:saved-id",
        model: "s2.1-pro-base",
      })
    ).rejects.toThrow(/reference_audio_base64 is required/);
  });

  it("probes the ready host, never the batch host", async () => {
    vi.stubEnv("MODAL_S2_TTS_URL", BATCH_HOST);
    vi.stubEnv("MODAL_S2_READY_URL", READY_HOST);
    vi.stubEnv("MODAL_S2_TOKEN", "test-token");
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(JSON.stringify(readyBody()), {
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const state = await modalClonePoolReady();
    expect(state.ready).toBe(true);
    expect(state.build).toBe("abc123def456");
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([READY_HOST]);
  });

  it("skips the probe entirely when no ready host is configured", async () => {
    vi.stubEnv("MODAL_S2_TTS_URL", BATCH_HOST);
    vi.stubEnv("MODAL_S2_READY_URL", "");
    vi.stubEnv("MODAL_S2_TOKEN", "test-token");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const state = await modalClonePoolReady();
    // Optimistic: the synthesize call's own timeout decides.
    expect(state.ready).toBe(true);
    expect(state.warmContainers).toBe(-1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fail the whole path when the ready URL is misconfigured", async () => {
    vi.stubEnv("MODAL_S2_TTS_URL", BATCH_HOST);
    vi.stubEnv("MODAL_S2_READY_URL", `${READY_HOST}/ready`);
    vi.stubEnv("MODAL_S2_TOKEN", "test-token");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const state = await modalClonePoolReady();
    expect(state.ready).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

/** A bare origin: scheme + host, no path, no query. */
function isOneOrigin(url: string): boolean {
  const parsed = new URL(url);
  return parsed.pathname === "/" && !parsed.search && !parsed.hash;
}
