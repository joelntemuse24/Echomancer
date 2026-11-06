/**
 * The voice list is on Vercel. Modal credentials live on the worker, so a
 * person who already has a trained clone asks the worker to restore while
 * they are still choosing. An account with no clone must not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pending: Promise<unknown>[] = [];

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (work: () => unknown) => {
      pending.push(Promise.resolve().then(() => work()));
    },
  };
});

import { GET as voicesGet } from "@/app/api/tts/voices/route";
import { execute } from "@/lib/turso";
import { buildRequest, resetDatabase } from "@/test/harness";
import { BATCH_HOST } from "@/lib/tts/providers/modal-endpoints.fixture";

const USER = "user_" + "c".repeat(32);

async function flushAfter(): Promise<void> {
  await Promise.all(pending.splice(0));
}

describe("voice list clone prewarm", () => {
  beforeEach(async () => {
    await resetDatabase();
    pending.length = 0;
    process.env.FISH_API_KEY = "test-fish";
    process.env.MODAL_S2_TTS_URL = BATCH_HOST;
    process.env.WORKER_URL = "https://worker.test";
    process.env.WORKER_SECRET = "s3cret";
    delete process.env.CLONE_TTS_PROVIDER;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FISH_API_KEY;
    delete process.env.MODAL_S2_TTS_URL;
    delete process.env.WORKER_URL;
    delete process.env.WORKER_SECRET;
    delete process.env.CLONE_TTS_PROVIDER;
  });

  it("does not call the worker when the account has no trained clone", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const response = await voicesGet(
      await buildRequest("/api/tts/voices", { userId: USER })
    );
    await flushAfter();
    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the worker to restore when a trained clone is on the list", async () => {
    await execute(
      `INSERT INTO cloned_voices
         (id, user_id, fish_voice_id, title, sample_storage_path, state, model)
       VALUES (?, ?, 'fish-ref', 'Ada', 'clones/ada/sample.wav', 'trained', 's2.1-pro-base')`,
      ["96a74157-aaaa-4bbb-8ccc-ddddeeeeffff", USER]
    );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, started: true }), { status: 202 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await voicesGet(
      await buildRequest("/api/tts/voices", { userId: USER })
    );
    await flushAfter();

    expect(response.status).toBe(200);
    const body = (await response.json()) as { voices: { id: string }[] };
    expect(body.voices.some((voice) => voice.id.startsWith("clone:"))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://worker.test/clone-prewarm");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer s3cret");
    expect(JSON.parse(String(init?.body))).toEqual({ userId: USER });
  });

  it("does not restore when clones are rendered somewhere else", async () => {
    process.env.CLONE_TTS_PROVIDER = "fish";
    await execute(
      `INSERT INTO cloned_voices
         (id, user_id, fish_voice_id, title, sample_storage_path, state, model)
       VALUES (?, ?, 'fish-ref', 'Ada', 'clones/ada/sample.wav', 'trained', 's2.1-pro-base')`,
      ["96a74157-aaaa-4bbb-8ccc-ddddeeeeffff", USER]
    );
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const response = await voicesGet(
      await buildRequest("/api/tts/voices", { userId: USER })
    );
    await flushAfter();
    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
