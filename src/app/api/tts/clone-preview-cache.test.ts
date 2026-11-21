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

import { createHash } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USER_A, USER_B, buildRequest, resetDatabase, routeParams } from "@/test/harness";
import { insertClonedVoice } from "@/lib/turso/cloned-voices";
import { catalogIdForClone } from "@/lib/tts/fish-clone";
import {
  CLONE_PREVIEW_AUDIO_CACHE,
  CLONE_PREVIEW_STATUS_CACHE,
  clonePreviewReadPaths,
  clonePreviewWritePath,
  findStoredClonePreview,
  planClonePreview,
  previewDeliveryInput,
} from "@/lib/tts/clone-preview";
import {
  CLONE_PREVIEW_RECIPE,
  clonePreviewPublicUrl,
  clonePreviewStoragePath,
  clonePreviewVersionToken,
  legacyClonePreviewStoragePath,
  readFirstStoredClonePreview,
  readStoredClonePreview,
} from "@/lib/tts/clone-preview-store";
import {
  CLONE_PREVIEW_REQUEST_VERSION,
  clonePreviewPollUrl,
  clonePreviewProbeUrl,
} from "@/lib/tts/clone-preview-url";
import { rememberClonePreviewPath } from "@/lib/tts/clone-preview-record";
import { verifyClonePreviewMediaToken } from "@/lib/tts/clone-preview-media";
import { PREVIEW_TEXT } from "@/lib/tts/preview-text";
import * as storage from "@/lib/storage";
import { uploadFile } from "@/lib/storage";

/** Looks like an MP3 to the silence guard. */
function fakeMp3(fill: number): Buffer {
  const bytes = Buffer.alloc(4096, fill);
  bytes[0] = 0xff;
  bytes[1] = 0xfb;
  return bytes;
}

/** A private response must not be a shared or CDN cache entry. */
function expectSharedCacheOff(res: Response) {
  const cache = res.headers.get("cache-control") ?? "";
  expect(cache).not.toMatch(/\bpublic\b|s-maxage/i);
  expect(res.headers.get("cdn-cache-control")).toBe("no-store");
  expect(res.headers.get("vercel-cdn-cache-control")).toBe("no-store");
  expect(res.headers.get("vary")).toMatch(/cookie/i);
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
    expect(res.headers.get("cache-control")).toBe(CLONE_PREVIEW_AUDIO_CACHE);
    expectSharedCacheOff(res);
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
    expect(Buffer.from(await res.arrayBuffer()).equals(stored)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams the remembered key and does not walk the other keys", async () => {
    const clone = await makeClone();
    const voice = voiceOf(clone);
    const plan = planFor(clone);
    const legacy = legacyClonePreviewStoragePath({
      catalogVoiceId: voice.id,
      providerVoiceId: voice.providerVoiceId,
      model: voice.model,
      script: plan.script,
      speed: plan.speed,
    })!;
    const stored = fakeMp3(13);
    await putObject(legacy, stored);
    await rememberClonePreviewPath(clone.id, legacy);
    const download = vi.spyOn(storage, "downloadFile");
    const stat = vi.spyOn(storage, "readObjectStat");

    const { GET } = await import("@/app/api/tts/clones/[id]/preview/route");
    const res = await GET(await request(clone.id, USER_A), routeParams({ id: clone.id }));

    expect(res.status).toBe(200);
    expect(res.headers.get("x-echomancer-preview")).toBe("stored");
    expect(res.headers.get("x-echomancer-preview-resolve")).toBe("stored");
    expect(res.headers.get("server-timing")).toMatch(/open;dur=\d/);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expectSharedCacheOff(res);
    expect(Buffer.from(await res.arrayBuffer()).equals(stored)).toBe(true);
    expect(download).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });

  it("uses a file token without stating the other keys", async () => {
    const clone = await makeClone();
    const voice = voiceOf(clone);
    const plan = planFor(clone);
    const key = {
      catalogVoiceId: voice.id,
      providerVoiceId: voice.providerVoiceId,
      model: voice.model,
      script: plan.script,
      speed: plan.speed,
    };
    const legacy = legacyClonePreviewStoragePath(key)!;
    const stored = fakeMp3(14);
    await putObject(legacy, stored);
    const download = vi.spyOn(storage, "downloadFile");
    const token = clonePreviewVersionToken(legacy);

    const { GET } = await import("@/app/api/tts/clones/[id]/preview/route");
    const res = await GET(
      await buildRequest(`/api/tts/clones/${clone.id}/preview?v=${token}`, {
        userId: USER_A,
        method: "GET",
      }),
      routeParams({ id: clone.id })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("x-echomancer-preview-resolve")).toBe("token");
    expect(Buffer.from(await res.arrayBuffer()).equals(stored)).toBe(true);
    expect(download).not.toHaveBeenCalled();
  });

  it("answers 304 when the browser still has this clip", async () => {
    const clone = await makeClone();
    const stored = fakeMp3(11);
    const path = clonePreviewWritePath(voiceOf(clone), planFor(clone))!;
    await putObject(path, stored);
    await rememberClonePreviewPath(clone.id, path);

    const { GET } = await import("@/app/api/tts/clones/[id]/preview/route");
    const first = await GET(await request(clone.id, USER_A), routeParams({ id: clone.id }));
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await GET(
      await buildRequest(`/api/tts/clones/${clone.id}/preview?v=clone-preview-v2`, {
        userId: USER_A,
        method: "GET",
        headers: { "if-none-match": etag! },
      }),
      routeParams({ id: clone.id })
    );
    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
    expect(second.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expectSharedCacheOff(second);
    expect(Buffer.from(await second.arrayBuffer()).length).toBe(0);
  });

  it("enqueues one bake and does not render when nothing is stored", async () => {
    const clone = await makeClone();
    const fetchMock = providerMock();
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("@/app/api/tts/clones/[id]/preview/route");
    const res = await GET(await request(clone.id, USER_A), routeParams({ id: clone.id }));
    expect(res.status).toBe(202);
    expect((await res.json()).code).toBe("PREVIEW_PREPARING");
    expect(res.headers.get("cache-control")).toBe(CLONE_PREVIEW_STATUS_CACHE);
    expectSharedCacheOff(res);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends no-store on a failed bake", async () => {
    const clone = await makeClone();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("reference not found", { status: 422 }))
    );
    const { bakeClonePreview } = await import("@/lib/tts/clone-preview-job");
    expect((await bakeClonePreview(clone.id)).status).toBe(409);

    const { GET } = await import("@/app/api/tts/clones/[id]/preview/route");
    const res = await GET(await request(clone.id, USER_A), routeParams({ id: clone.id }));
    expect(res.status).toBe(409);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expectSharedCacheOff(res);
  });

  it("accepts the catalog id as well as the row id", async () => {
    const clone = await makeClone();
    const { GET } = await import("@/app/api/tts/clones/[id]/preview/route");
    const res = await GET(
      await request(catalogIdForClone(clone.id), USER_A),
      routeParams({ id: catalogIdForClone(clone.id) })
    );
    expect(res.status).toBe(202);
    expect((await res.json()).code).toBe("PREVIEW_PREPARING");
  });

  it("plays the stored clip on the next poll and does not start another bake", async () => {
    const clone = await makeClone();
    const { GET } = await import("@/app/api/tts/clones/[id]/preview/route");
    const waiting = await GET(await request(clone.id, USER_A), routeParams({ id: clone.id }));
    expect(waiting.status).toBe(202);

    const stored = fakeMp3(12);
    const path = clonePreviewWritePath(voiceOf(clone), planFor(clone))!;
    await putObject(path, stored);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const poll = await GET(
      await buildRequest(clonePreviewPollUrl(catalogIdForClone(clone.id), 50), {
        userId: USER_A,
        method: "GET",
      }),
      routeParams({ id: clone.id })
    );
    expect(poll.status).toBe(200);
    expect(poll.headers.get("x-echomancer-preview")).toBe("stored");
    expect(Buffer.from(await poll.arrayBuffer()).equals(stored)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports another session's clone as 404 and never reads its clip", async () => {
    const clone = await makeClone();
    const stored = fakeMp3(11);
    await putObject(clonePreviewWritePath(voiceOf(clone), planFor(clone))!, stored);

    const { GET } = await import("@/app/api/tts/clones/[id]/preview/route");
    const res = await GET(await request(clone.id, USER_B), routeParams({ id: clone.id }));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") || "").toMatch(/json/);
    expectSharedCacheOff(res);
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

    const { bakeClonePreview } = await import("@/lib/tts/clone-preview-job");
    const first = await bakeClonePreview(clone.id);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-echomancer-preview")).toBe("generated");
    const firstBytes = Buffer.from(await first.arrayBuffer());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The take is on disk under the key the GET route reads.
    const voice = voiceOf(clone);
    const plan = planFor(clone);
    const writePath = clonePreviewWritePath(voice, plan, PREVIEW_TEXT, "fish")!;
    expect(
      await readStoredClonePreview(clonePreviewWritePath(voice, plan, PREVIEW_TEXT, "s2-pro")!)
    ).toBeNull();
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

    const { bakeClonePreview } = await import("@/lib/tts/clone-preview-job");
    const res = await bakeClonePreview(clone.id);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("PREVIEW_BAKE_FAILED");
    expect(body.error).toMatch(/couldn't prepare the preview/i);
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

  it("stores a Fish take while the S2 pool would answer 503", async () => {
    const clone = await makeClone();
    vi.stubEnv("MODAL_S2_TTS_URL", "https://acme--echomancer-s2-clone-synthesize-batch.modal.run");
    vi.stubEnv("MODAL_S2_TOKEN", "test-token");
    vi.stubEnv("MODAL_S2_READY", "0");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("modal.run")) return new Response("upstream unavailable", { status: 503 });
      return new Response(fakeMp3(13), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { bakeClonePreview } = await import("@/lib/tts/clone-preview-job");
    const res = await bakeClonePreview(clone.id);

    expect(res.status).toBe(200);
    expect(res.headers.get("x-echomancer-preview")).toBe("generated");
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("modal.run"))).toBe(true);
    const fishPath = clonePreviewWritePath(voiceOf(clone), planFor(clone), PREVIEW_TEXT, "fish")!;
    expect(await readStoredClonePreview(fishPath)).not.toBeNull();
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

  it("reads fish, then the legacy file, then s2-pro", () => {
    const clone = { id: CLONE_ID, fish_voice_id: "fish-ref-wolfe", model: "s2.1-pro-free" };
    const voice = voiceOf(clone);
    const plan = planFor(clone);
    const key = {
      catalogVoiceId: voice.id,
      providerVoiceId: voice.providerVoiceId,
      model: voice.model,
      script: plan.script,
      speed: plan.speed,
    };
    const paths = clonePreviewReadPaths(voice, plan, PREVIEW_TEXT, "s2-pro");
    // Asking for s2-pro does not put that key first. New bakes are fish.
    expect(paths).toHaveLength(3);
    expect(paths[0]).toBe(clonePreviewWritePath(voice, plan, PREVIEW_TEXT, "fish"));
    expect(paths[1]).toBe(legacyClonePreviewStoragePath(key));
    expect(paths[2]).toBe(clonePreviewWritePath(voice, plan, PREVIEW_TEXT, "s2-pro"));
    expect(new Set(paths).size).toBe(3);
    expect(paths.join()).not.toMatch(/drama/i);
  });

  it("stops after the fish object, and reads legacy before s2-pro", async () => {
    const key = {
      catalogVoiceId: catalogIdForClone(CLONE_ID),
      providerVoiceId: "fish-ref-wolfe",
      model: "s2.1-pro-free",
      script: PREVIEW_TEXT,
      speed: 1,
    };
    const fish = clonePreviewStoragePath(key, "fish")!;
    const legacy = legacyClonePreviewStoragePath(key)!;
    const s2 = clonePreviewStoragePath(key, "s2-pro")!;
    await putObject(fish, fakeMp3(4));
    const download = vi.spyOn(storage, "downloadFile");
    const found = await readFirstStoredClonePreview(key, "s2-pro");
    expect(found?.path).toBe(fish);
    expect(download.mock.calls.map((call) => call[0])).toEqual([fish]);
    download.mockClear();

    await storage.deleteFile(fish);
    await putObject(legacy, fakeMp3(5));
    const older = await readFirstStoredClonePreview(key, "s2-pro");
    expect(older?.path).toBe(legacy);
    expect(download.mock.calls.map((call) => call[0])).toEqual([fish, legacy]);
    expect(download.mock.calls.map((call) => call[0])).not.toContain(s2);
  });

  it("changes the preview URL when the stored key or the recipe changes", () => {
    const key = {
      catalogVoiceId: catalogIdForClone(CLONE_ID),
      providerVoiceId: "fish-ref-wolfe",
      model: "s2.1-pro-free",
      script: PREVIEW_TEXT,
      speed: 1,
    };
    expect(CLONE_PREVIEW_REQUEST_VERSION).toBe(CLONE_PREVIEW_RECIPE);
    const fish = clonePreviewStoragePath(key, "fish")!;
    const legacy = legacyClonePreviewStoragePath(key)!;
    const fishToken = clonePreviewVersionToken(fish);
    expect(fishToken).not.toBe(clonePreviewVersionToken(legacy));
    expect(fishToken).toBe(
      createHash("sha256")
        .update(CLONE_PREVIEW_RECIPE)
        .update("\0")
        .update(fish)
        .digest("hex")
        .slice(0, 16)
    );
    const otherRecipe = createHash("sha256")
      .update("clone-preview-v3")
      .update("\0")
      .update(fish)
      .digest("hex")
      .slice(0, 16);
    expect(fishToken).not.toBe(otherRecipe);

    const url = clonePreviewPublicUrl(key.catalogVoiceId, fish);
    expect(url.startsWith("/api/tts/clone-preview/")).toBe(true);
    expect(url).not.toContain(key.catalogVoiceId);
    expect(url).not.toMatch(/[?&](?:v|_)=/);
    const signed = decodeURIComponent(url.slice("/api/tts/clone-preview/".length));
    expect(verifyClonePreviewMediaToken(signed)).toBe(fish);
    const legacyUrl = clonePreviewPublicUrl(key.catalogVoiceId, legacy);
    expect(legacyUrl).not.toBe(url);
    expect(verifyClonePreviewMediaToken(
      decodeURIComponent(legacyUrl.slice("/api/tts/clone-preview/".length))
    )).toBe(legacy);
    const probe = clonePreviewProbeUrl(key.catalogVoiceId);
    expect(probe).toBe(
      `/api/tts/clones/${encodeURIComponent(key.catalogVoiceId)}/preview?v=${encodeURIComponent(CLONE_PREVIEW_RECIPE)}`
    );
    expect(probe).not.toMatch(/[?&]_=/);
    expect(clonePreviewPollUrl(key.catalogVoiceId, 50)).toBe(
      `/api/tts/clones/${encodeURIComponent(key.catalogVoiceId)}/preview?poll=1&_=50`
    );
  });

  it("reads the other engine's take so a stored clip is never re-rendered", () => {
    // A preview used to be rendered by direct Fish; the clone now books on S2.
    // The Fish take is the same voice and already paid for, so it must be found
    // rather than paying a GPU restore to re-render the identical line.
    const clone = { id: CLONE_ID, fish_voice_id: "fish-ref-wolfe", model: "s2.1-pro-free" };
    const voice = voiceOf(clone);
    const plan = planFor(clone);
    expect(clonePreviewReadPaths(voice, plan, PREVIEW_TEXT, "fish")).toContain(
      clonePreviewWritePath(voice, plan, PREVIEW_TEXT, "s2-pro")
    );
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
    expect(res.status).toBe(202);
    expect((await res.json()).code).toBe("PREVIEW_PREPARING");
  });
});

describe("GET /api/tts/voices previewUrl", () => {
  it("points a stored clone at its versioned clip and does not bake a missing one", async () => {
    const clone = await makeClone();
    const voice = voiceOf(clone);
    const plan = planFor(clone);
    const fish = clonePreviewWritePath(voice, plan, PREVIEW_TEXT, "fish")!;
    await putObject(fish, fakeMp3(9));
    const meta = vi.spyOn(storage, "readObjectStat");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("@/app/api/tts/voices/route");
    const res = await GET(await buildRequest("/api/tts/voices", { userId: USER_A }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      voices: { id: string; previewUrl?: string }[];
    };
    const listed = body.voices.find((item) => item.id === voice.id);
    expect(listed?.previewUrl).toBe(clonePreviewPublicUrl(voice.id, fish));
    expect(listed?.previewUrl).not.toMatch(/[?&]_=/);
    const heads = meta.mock.calls.map((call) => call[0]);
    expect(heads[0]).toBe(fish);
    expect(heads).not.toContain(
      clonePreviewStoragePath(
        {
          catalogVoiceId: voice.id,
          providerVoiceId: voice.providerVoiceId,
          model: voice.model,
          script: plan.script,
          speed: plan.speed,
        },
        "s2-pro"
      )
    );
    expect(fetchMock).not.toHaveBeenCalled();

    meta.mockClear();
    const again = await GET(await buildRequest("/api/tts/voices", { userId: USER_A }));
    const againBody = (await again.json()) as {
      voices: { id: string; previewUrl?: string }[];
    };
    expect(againBody.voices.find((item) => item.id === voice.id)?.previewUrl).toBe(
      clonePreviewPublicUrl(voice.id, fish)
    );
    expect(meta).not.toHaveBeenCalled();
  });

  it("omits previewUrl when the clone has no stored clip", async () => {
    const clone = await makeClone();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("@/app/api/tts/voices/route");
    const res = await GET(await buildRequest("/api/tts/voices", { userId: USER_A }));
    const body = (await res.json()) as {
      voices: { id: string; previewUrl?: string }[];
    };
    const listed = body.voices.find((item) => item.id === catalogIdForClone(clone.id));
    expect(listed).toBeTruthy();
    expect(listed?.previewUrl).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    const stat = vi.spyOn(storage, "readObjectStat");
    const second = await GET(await buildRequest("/api/tts/voices", { userId: USER_A }));
    const secondBody = (await second.json()) as {
      voices: { id: string; previewUrl?: string }[];
    };
    expect(
      secondBody.voices.find((item) => item.id === catalogIdForClone(clone.id))?.previewUrl
    ).toBeUndefined();
    expect(stat).not.toHaveBeenCalled();
  });

  it("does not remember a miss when storage cannot be read", async () => {
    const clone = await makeClone();
    vi.spyOn(storage, "readObjectStat").mockRejectedValue(new Error("storage down"));
    const { GET } = await import("@/app/api/tts/voices/route");
    const first = await GET(await buildRequest("/api/tts/voices", { userId: USER_A }));
    const firstBody = (await first.json()) as {
      voices: { id: string; previewUrl?: string }[];
    };
    expect(
      firstBody.voices.find((item) => item.id === catalogIdForClone(clone.id))?.previewUrl
    ).toBeUndefined();

    vi.mocked(storage.readObjectStat).mockRestore();
    const stat = vi.spyOn(storage, "readObjectStat");
    await GET(await buildRequest("/api/tts/voices", { userId: USER_A }));
    expect(stat.mock.calls.length).toBeGreaterThan(0);
  });

  it("keeps another person's clip off this list", async () => {
    const clone = await makeClone();
    const voice = voiceOf(clone);
    await putObject(clonePreviewWritePath(voice, planFor(clone))!, fakeMp3(9));
    const { GET } = await import("@/app/api/tts/voices/route");
    const res = await GET(await buildRequest("/api/tts/voices", { userId: USER_B }));
    const body = (await res.json()) as { voices: { id: string; previewUrl?: string }[] };
    expect(body.voices.some((item) => item.id === voice.id)).toBe(false);
    expect(body.voices.some((item) => item.previewUrl?.includes(clone.id))).toBe(false);
  });

  it("uses the path a bake just stored and does not stat again", async () => {
    const clone = await makeClone();
    vi.stubGlobal("fetch", providerMock(8));
    const { bakeClonePreview } = await import("@/lib/tts/clone-preview-job");
    expect((await bakeClonePreview(clone.id)).status).toBe(200);
    const stat = vi.spyOn(storage, "readObjectStat");
    const { GET } = await import("@/app/api/tts/voices/route");
    const res = await GET(await buildRequest("/api/tts/voices", { userId: USER_A }));
    const body = (await res.json()) as { voices: { id: string; previewUrl?: string }[] };
    const listed = body.voices.find((item) => item.id === catalogIdForClone(clone.id));
    expect(listed?.previewUrl).toBe(
      clonePreviewPublicUrl(
        catalogIdForClone(clone.id),
        clonePreviewWritePath(voiceOf(clone), planFor(clone))!
      )
    );
    expect(stat).not.toHaveBeenCalled();
  });
});
