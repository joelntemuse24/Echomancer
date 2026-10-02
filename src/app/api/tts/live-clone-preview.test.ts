/**
 * Saved clone previews: Fish runs once, later plays come from storage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USER_A, USER_B, buildRequest, resetDatabase } from "@/test/harness";
import { insertClonedVoice } from "@/lib/turso/cloned-voices";
import { catalogIdForClone } from "@/lib/tts/fish-clone";
import {
  clonePreviewStoragePath,
  readStoredClonePreview,
} from "@/lib/tts/clone-preview-store";

/** Looks like an MP3 to the silence guard. */
function fakeMp3(fill: number): Uint8Array {
  const bytes = new Uint8Array(4096).fill(fill);
  bytes[0] = 0xff;
  bytes[1] = 0xfb;
  return bytes;
}

function fishOk(fill: number) {
  return vi.fn(
    async () =>
      new Response(fakeMp3(fill), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      })
  );
}

async function makeClone(userId: string, fishVoiceId = "fish-ref-a") {
  return insertClonedVoice({
    userId,
    fishVoiceId,
    title: "Mine",
    state: "trained",
    model: "s2.1-pro-free",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.FISH_API_KEY;
});

beforeEach(async () => {
  await resetDatabase();
  process.env.FISH_API_KEY = "test-key";
});

describe("clone preview storage", () => {
  it("calls Fish on the first play only, then serves the stored file", async () => {
    const clone = await makeClone(USER_A);
    const fetchMock = fishOk(7);
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("@/app/api/tts/live/route");
    const url = `/api/tts/live?catalogVoiceId=${catalogIdForClone(clone.id)}`;

    const first = await GET(await buildRequest(url, { userId: USER_A, method: "GET" }));
    expect(first.status).toBe(200);
    expect(first.headers.get("x-echomancer-preview")).toBe("generated");
    const firstBytes = new Uint8Array(await first.arrayBuffer());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await GET(
      await buildRequest(`${url}&_=2`, { userId: USER_A, method: "GET" })
    );
    expect(second.status).toBe(200);
    expect(second.headers.get("x-echomancer-preview")).toBe("stored");
    expect(second.headers.get("content-type")).toBe("audio/mpeg");
    const secondBytes = new Uint8Array(await second.arrayBuffer());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Buffer.from(secondBytes).equals(Buffer.from(firstBytes))).toBe(true);
  });

  it("does not store or serve a preview for custom sample text", async () => {
    const clone = await makeClone(USER_A);
    const fetchMock = fishOk(5);
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("@/app/api/tts/live/route");
    const url = `/api/tts/live?catalogVoiceId=${catalogIdForClone(clone.id)}&text=${encodeURIComponent("A different line to read.")}`;

    for (let i = 0; i < 2; i++) {
      const res = await GET(await buildRequest(url, { userId: USER_A, method: "GET" }));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-echomancer-preview")).toBeNull();
      await res.arrayBuffer();
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never serves another user's clone preview", async () => {
    const clone = await makeClone(USER_A);
    const fetchMock = fishOk(9);
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("@/app/api/tts/live/route");
    const url = `/api/tts/live?catalogVoiceId=${catalogIdForClone(clone.id)}`;

    const owner = await GET(await buildRequest(url, { userId: USER_A, method: "GET" }));
    await owner.arrayBuffer();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const other = await GET(await buildRequest(url, { userId: USER_B, method: "GET" }));
    expect(other.status).toBe(404);
    expect(other.headers.get("content-type") || "").toMatch(/json/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keys the file on reference, model, speed and script", async () => {
    const base = {
      catalogVoiceId: "clone:abc-123",
      providerVoiceId: "fish-ref-a",
      model: "s2.1-pro-free",
      script: "Hello there.",
      speed: 0.85,
    };
    const path = clonePreviewStoragePath(base)!;
    expect(path).toMatch(/^previews\/clones\/abc-123\/[0-9a-f]{32}\.mp3$/);
    expect(clonePreviewStoragePath({ ...base })).toBe(path);
    expect(clonePreviewStoragePath({ ...base, providerVoiceId: "fish-ref-b" })).not.toBe(path);
    expect(clonePreviewStoragePath({ ...base, model: "s2-pro" })).not.toBe(path);
    expect(clonePreviewStoragePath({ ...base, speed: 1 })).not.toBe(path);
    expect(clonePreviewStoragePath({ ...base, script: "Other." })).not.toBe(path);
    expect(clonePreviewStoragePath({ ...base, catalogVoiceId: "fish-narrator" })).toBeNull();
    expect(clonePreviewStoragePath({ ...base, catalogVoiceId: "clone:../x" })).toBeNull();
    expect(clonePreviewStoragePath({ ...base, providerVoiceId: "" })).toBeNull();
  });

  it("regenerates after the clone's Fish reference changes", async () => {
    const clone = await makeClone(USER_A, "fish-ref-old");
    const fetchMock = fishOk(3);
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("@/app/api/tts/live/route");
    const url = `/api/tts/live?catalogVoiceId=${catalogIdForClone(clone.id)}`;

    await (await GET(await buildRequest(url, { userId: USER_A, method: "GET" }))).arrayBuffer();
    const { execute } = await import("@/lib/turso");
    await execute("UPDATE cloned_voices SET fish_voice_id = ? WHERE id = ?", [
      "fish-ref-new",
      clone.id,
    ]);
    const after = await GET(await buildRequest(url, { userId: USER_A, method: "GET" }));
    expect(after.headers.get("x-echomancer-preview")).toBe("generated");
    await after.arrayBuffer();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a missing stored file as no preview", async () => {
    expect(await readStoredClonePreview("previews/clones/none/missing.mp3")).toBeNull();
  });
});
