/**
 * A saved clone's picker preview must not synthesize more than once.
 *
 * Four contracts are pinned here:
 *   1. `GET /api/tts/clones/[id]/preview` answers from storage and never calls
 *      the provider — selecting a saved voice cannot start a GPU restore.
 *   2. The legacy engine-free key is read, so the Fish 2.1 Pro previews from
 *      before the S2 pool are reused instead of re-rendered.
 *   3. `POST` renders once on the clone's own engine and stores the take. A
 *      failure is reported, never answered by a different voice.
 *   4. Both routes derive the same key, so a write can always be found again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USER_A, USER_B, buildRequest, resetDatabase, routeParams } from "@/test/harness";
import { insertClonedVoice } from "@/lib/turso/cloned-voices";
import { catalogIdForClone } from "@/lib/tts/fish-clone";
import {
  clonePreviewReadPaths,
  clonePreviewWritePath,
  findStoredClonePreview,
  planClonePreview,
  previewDeliveryInput,
} from "@/lib/tts/clone-preview";
import {
  clonePreviewStoragePath,
  legacyClonePreviewStoragePath,
  readStoredClonePreview,
} from "@/lib/tts/clone-preview-store";
import { PREVIEW_TEXT } from "@/lib/tts/preview-text";
import { uploadFile } from "@/lib/storage";

/** Looks like an MP3 to the silence guard. */
function fakeMp3(fill: number): Buffer {
  const bytes = Buffer.alloc(4096, fill);
  bytes[0] = 0xff;
  bytes[1] = 0xfb;
  return bytes;
}

/** Every outbound provider call this route made. */
function providerMock(fill = 7) {
  return vi.fn(
    async () =>
      new Response(fakeMp3(fill), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      })
  );
}

const CLONE_ID = "96a74157-aaaa-4bbb-8ccc-ddddeeeeffff";

async function makeClone(userId = USER_A) {
  return insertClonedVoice({
    id: CLONE_ID,
    userId,
    fishVoiceId: "fish-ref-wolfe",
    title: "Tom Wolfe",
    state: "trained",
    model: "s2.1-pro-free",
  });
}

async function putObject(storagePath: string, bytes: Buffer) {
  const slash = storagePath.lastIndexOf("/");
  await uploadFile(
    storagePath.slice(0, slash),
    storagePath.slice(slash + 1),
    bytes,
    "audio/mpeg"
  );
}

function voiceOf(clone: { id: string; fish_voice_id: string; model: string }) {
  return {
    id: catalogIdForClone(clone.id),
    providerVoiceId: clone.fish_voice_id,
    model: clone.model,
  };
}

function planFor(clone: { id: string }) {
  return planClonePreview({
    catalogVoiceId: catalogIdForClone(clone.id),
    text: PREVIEW_TEXT,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.FISH_API_KEY;
  delete process.env.MODAL_S2_TTS_URL;
  delete process.env.MODAL_S2_TOKEN;
  delete process.env.CLONE_TTS_PROVIDER;
});

beforeEach(async () => {
  await resetDatabase();
  process.env.FISH_API_KEY = "test-key";
});

describe("GET /api/tts/clones/[id]/preview", () => {
  function request(id: string, userId: string) {
    return buildRequest(`/api/tts/clones/${id}/preview`, { userId, method: "GET" });
  }

  it("serves a stored clip with zero provider calls", async () => {
    const clone = await makeClone();
    const stored = fakeMp3(11);
    await putObject(clonePreviewWritePath(voiceOf(clone), planFor(clone))!, stored);

    const fetchMock = providerMock();
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("@/app/api/tts/clones/[id]/preview/route");
    const res = await GET(await request(clone.id, USER_A), routeParams({ id: clone.id }));

    expect(res.status).toBe(200);
    expect(res.headers.get("x-echomancer-preview")).toBe("stored");
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(Buffer.from(await res.arrayBuffer()).equals(stored)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 404 with PREVIEW_NOT_STORED before the first render", async () => {
    const clone = await makeClone();
    const fetchMock = providerMock();
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("@/app/api/tts/clones/[id]/preview/route");
    const res = await GET(await request(clone.id, USER_A), routeParams({ id: clone.id }));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("PREVIEW_NOT_STORED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the catalog id as well as the row id", async () => {
    const clone = await makeClone();
    const { GET } = await import("@/app/api/tts/clones/[id]/preview/route");
    const res = await GET(
      await request(catalogIdForClone(clone.id), USER_A),
      routeParams({ id: catalogIdForClone(clone.id) })
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("PREVIEW_NOT_STORED");
  });

  it("reports another session's clone as 404 and never reads its clip", async () => {
    const clone = await makeClone();
    const stored = fakeMp3(11);
    await putObject(clonePreviewWritePath(voiceOf(clone), planFor(clone))!, stored);

    const { GET } = await import("@/app/api/tts/clones/[id]/preview/route");
    const res = await GET(await request(clone.id, USER_B), routeParams({ id: clone.id }));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") || "").toMatch(/json/);
  });

  it("returns 503 when cloning is not configured", async () => {
    delete process.env.FISH_API_KEY;
    const clone = await makeClone();
    const { GET } = await import("@/app/api/tts/clones/[id]/preview/route");
    const res = await GET(await request(clone.id, USER_A), routeParams({ id: clone.id }));
    expect(res.status).toBe(503);
  });
});

describe("POST /api/tts/clones/[id]/preview", () => {
  function render(id: string, userId: string) {
    return buildRequest(`/api/tts/clones/${id}/preview`, {
      userId,
      method: "POST",
      body: {},
    });
  }

  it("renders once, stores under the engine's key, and replays from storage", async () => {
    const clone = await makeClone();
    const fetchMock = providerMock(13);
    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("@/app/api/tts/clones/[id]/preview/route");
    const first = await POST(await render(clone.id, USER_A), routeParams({ id: clone.id }));
    expect(first.status).toBe(200);
    expect(first.headers.get("x-echomancer-preview")).toBe("generated");
    const firstBytes = Buffer.from(await first.arrayBuffer());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The take is on disk under the key the GET route reads.
    const voice = voiceOf(clone);
    const plan = planFor(clone);
    const writePath = clonePreviewWritePath(voice, plan)!;
    const stored = await readStoredClonePreview(writePath);
    expect(stored?.equals(firstBytes)).toBe(true);

    // Second play is a plain read: no provider call at all.
    const { GET } = await import("@/app/api/tts/clones/[id]/preview/route");
    const second = await GET(
      await buildRequest(`/api/tts/clones/${clone.id}/preview`, {
        userId: USER_A,
        method: "GET",
      }),
      routeParams({ id: clone.id })
    );
    expect(second.status).toBe(200);
    expect(second.headers.get("x-echomancer-preview")).toBe("stored");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not re-render when a take is already stored", async () => {
    const clone = await makeClone();
    const stored = fakeMp3(21);
    await putObject(clonePreviewWritePath(voiceOf(clone), planFor(clone))!, stored);

    const fetchMock = providerMock();
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("@/app/api/tts/clones/[id]/preview/route");
    const res = await POST(await render(clone.id, USER_A), routeParams({ id: clone.id }));

    expect(res.status).toBe(200);
    expect(res.headers.get("x-echomancer-preview")).toBe("stored");
    expect(Buffer.from(await res.arrayBuffer()).equals(stored)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a failed render instead of substituting another voice", async () => {
    const clone = await makeClone();
    const fetchMock = vi.fn(async () => new Response("reference not found", { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("@/app/api/tts/clones/[id]/preview/route");
    const res = await POST(await render(clone.id, USER_A), routeParams({ id: clone.id }));

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("PREVIEW_RENDER_FAILED");
    expect(body.error).toMatch(/nothing else was substituted/i);
    // No provider wording leaks to the person.
    expect(body.error).not.toMatch(/422|reference not found|modal/i);
    // Nothing was stored under any key, so no substitute can ever be served.
    const plan = planFor(clone);
    expect(
      await findStoredClonePreview(voiceOf(clone), plan)
    ).toBeNull();
    // And the failure did not wander off to OpenRouter.
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("openrouter"))).toBe(
      true
    );
  });

  it("reports a cold pool as a wait, not a broken voice", async () => {
    // A clone with a real reference, so the call reaches the pool at all.
    const clone = await insertClonedVoice({
      id: CLONE_ID,
      userId: USER_A,
      fishVoiceId: "fish-ref-wolfe",
      title: "Tom Wolfe",
      state: "trained",
      model: "s2.1-pro-free",
      sampleStoragePath: `clones/${CLONE_ID}/sample.wav`,
    });
    await putObject(`clones/${CLONE_ID}/sample.wav`, fakeMp3(3));

    // The batch host answers a gateway timeout: the container is not serving.
    vi.stubEnv("MODAL_S2_TTS_URL", "https://acme--echomancer-s2-clone-synthesize-batch.modal.run");
    vi.stubEnv("MODAL_S2_TOKEN", "test-token");
    vi.stubEnv("MODAL_S2_READY", "0");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream unavailable", { status: 503 }))
    );

    const { POST } = await import("@/app/api/tts/clones/[id]/preview/route");
    const res = await POST(await render(clone.id, USER_A), routeParams({ id: clone.id }));

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("PREVIEW_ENGINE_COLD");
    expect(body.error).toMatch(/starting up/i);
    expect(body.error).toMatch(/nothing else was substituted/i);
    // Still nothing stored: a cold preview is not a take.
    expect(await findStoredClonePreview(voiceOf(clone), planFor(clone))).toBeNull();
  });

  it("is user-scoped", async () => {
    const clone = await makeClone();
    const fetchMock = providerMock();
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("@/app/api/tts/clones/[id]/preview/route");
    const res = await POST(await render(clone.id, USER_B), routeParams({ id: clone.id }));
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("preview key derivation", () => {
  it("names the engine, never Drama", () => {
    const key = {
      catalogVoiceId: catalogIdForClone(CLONE_ID),
      providerVoiceId: "fish-ref-wolfe",
      model: "s2.1-pro-free",
      script: PREVIEW_TEXT,
      speed: 0.85,
    };
    const s2 = clonePreviewStoragePath(key, "s2-pro");
    const fish = clonePreviewStoragePath(key, "fish");
    expect(s2).toMatch(new RegExp(`^previews/clones/${CLONE_ID}/[0-9a-f]{32}\\.mp3$`));
    expect(fish).not.toBe(s2);
    expect(`${s2}${fish}`).not.toMatch(/drama/i);
    // The old engine-free recipe is reproducible, which is what makes the
    // pre-S2 Fish 2.1 files findable with no migration.
    expect(legacyClonePreviewStoragePath(key)).not.toBe(s2);
  });

  it("reads the engine's take before the legacy Fish 2.1 file", () => {
    const clone = { id: CLONE_ID, fish_voice_id: "fish-ref-wolfe", model: "s2.1-pro-free" };
    const paths = clonePreviewReadPaths(voiceOf(clone), planFor(clone));
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe(clonePreviewWritePath(voiceOf(clone), planFor(clone)));
    expect(paths[1]).toMatch(new RegExp(`^previews/clones/${CLONE_ID}/`));
  });

  it("derives the same key with or without delivery preferences", () => {
    // The cache route has no preferences to apply, so the live route must
    // ignore them for a clone's fixed one-liner. If it did not, a saved clip
    // would never be found and every select would synthesize.
    const voice = { id: catalogIdForClone(CLONE_ID), providerVoiceId: "fish-ref-wolfe", model: "s2.1-pro-free" };
    const plain = planClonePreview({ catalogVoiceId: voice.id, text: PREVIEW_TEXT });
    const tuned = planClonePreview({
      catalogVoiceId: voice.id,
      text: PREVIEW_TEXT,
      ttsOptions: { pauseStyle: "normal", normalizeTitles: true, deliveryPrefix: true },
    });
    expect(tuned).toEqual(plain);
    expect(clonePreviewWritePath(voice, tuned)).toBe(clonePreviewWritePath(voice, plain));
  });

  it("passes delivery preferences through for a stock preview", () => {
    const prefs = { normalizeTitles: true, pauseStyle: "normal" as const };
    expect(previewDeliveryInput("fish-narrator", PREVIEW_TEXT, prefs)).toBe(prefs);
    expect(
      previewDeliveryInput(catalogIdForClone(CLONE_ID), PREVIEW_TEXT, prefs)
    ).toBeUndefined();
  });

  it("treats a silent stored object as no preview", async () => {
    const clone = await makeClone();
    const path = clonePreviewWritePath(voiceOf(clone), planFor(clone))!;
    // A zero-filled object is the classic provider failure, and must not be
    // served as if it were a take.
    await putObject(path, Buffer.alloc(4096, 0));
    expect(await readStoredClonePreview(path)).toBeNull();

    const { GET } = await import("@/app/api/tts/clones/[id]/preview/route");
    const res = await GET(
      await buildRequest(`/api/tts/clones/${clone.id}/preview`, {
        userId: USER_A,
        method: "GET",
      }),
      routeParams({ id: clone.id })
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("PREVIEW_NOT_STORED");
  });
});
