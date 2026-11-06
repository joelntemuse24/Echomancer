/**
 * A saved clone's picker preview must not synthesize more than once.
 *
 * Three contracts are pinned here:
 *   1. `/api/tts/clones/[id]/preview` answers from storage and never calls the
 *      provider — so selecting a saved voice is instant, and a cold GPU pool
 *      cannot make it feel like a regeneration.
 *   2. It derives the same storage key `/api/tts/live` writes, so the two can
 *      never disagree about where a take lives.
 *   3. It is user-scoped: another session's clone is 404, and the id is never
 *      treated as a secret.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USER_A, USER_B, buildRequest, resetDatabase, routeParams } from "@/test/harness";
import { insertClonedVoice } from "@/lib/turso/cloned-voices";
import { catalogIdForClone } from "@/lib/tts/fish-clone";
import {
  clonePreviewPathForCatalog,
  planClonePreview,
  previewDeliveryInput,
  storedClonePreviewAudio,
} from "@/lib/tts/clone-preview";
import { clonePreviewStoragePath } from "@/lib/tts/clone-preview-store";
import { PREVIEW_TEXT } from "@/lib/tts/preview-text";
import { uploadFile } from "@/lib/storage";

/** Looks like an MP3 to the silence guard. */
function fakeMp3(fill: number): Buffer {
  const bytes = Buffer.alloc(4096, fill);
  bytes[0] = 0xff;
  bytes[1] = 0xfb;
  return bytes;
}

function fishMock(fill = 7) {
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

function previewRequest(id: string, userId: string) {
  return buildRequest(`/api/tts/clones/${id}/preview`, {
    userId,
    method: "GET",
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
  await makeClone();
});

describe("GET /api/tts/clones/[id]/preview", () => {
  it("serves the stored clip without calling the provider", async () => {
    const fetchMock = fishMock();
    vi.stubGlobal("fetch", fetchMock);

    // First play has nothing stored: the live route renders and stores it.
    const { GET: live } = await import("@/app/api/tts/live/route");
    const liveRes = await live(
      await buildRequest(
        `/api/tts/live?catalogVoiceId=${catalogIdForClone(CLONE_ID)}`,
        { userId: USER_A, method: "GET" }
      )
    );
    expect(liveRes.headers.get("x-echomancer-preview")).toBe("generated");
    const generated = Buffer.from(await liveRes.arrayBuffer());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Every play after that asks the cache route first, which never synthesizes.
    const { GET: preview } = await import(
      "@/app/api/tts/clones/[id]/preview/route"
    );
    const res = await preview(
      await previewRequest(CLONE_ID, USER_A),
      routeParams({ id: CLONE_ID })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-echomancer-preview")).toBe("stored");
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    const served = Buffer.from(await res.arrayBuffer());
    expect(served.equals(generated)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("answers 404 with PREVIEW_NOT_STORED before the first render", async () => {
    const fetchMock = fishMock();
    vi.stubGlobal("fetch", fetchMock);

    const { GET: preview } = await import(
      "@/app/api/tts/clones/[id]/preview/route"
    );
    const res = await preview(
      await previewRequest(CLONE_ID, USER_A),
      routeParams({ id: CLONE_ID })
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("PREVIEW_NOT_STORED");
    // A cache probe is never a synthesis call.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the catalog id as well as the row id", async () => {
    const { GET: preview } = await import(
      "@/app/api/tts/clones/[id]/preview/route"
    );
    const forCatalogId = await preview(
      await previewRequest(catalogIdForClone(CLONE_ID), USER_A),
      routeParams({ id: catalogIdForClone(CLONE_ID) })
    );
    expect(forCatalogId.status).toBe(404);
    expect((await forCatalogId.json()).code).toBe("PREVIEW_NOT_STORED");
  });

  it("reports another session's clone as 404 and never reads its clip", async () => {
    const fetchMock = fishMock();
    vi.stubGlobal("fetch", fetchMock);

    const { GET: live } = await import("@/app/api/tts/live/route");
    await (
      await live(
        await buildRequest(
          `/api/tts/live?catalogVoiceId=${catalogIdForClone(CLONE_ID)}`,
          { userId: USER_A, method: "GET" }
        )
      )
    ).arrayBuffer();

    const { GET: preview } = await import(
      "@/app/api/tts/clones/[id]/preview/route"
    );
    const res = await preview(
      await previewRequest(CLONE_ID, USER_B),
      routeParams({ id: CLONE_ID })
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") || "").toMatch(/json/);
    expect((await res.json()).code).toBe("NOT_FOUND");
  });

  it("keys the cache on exactly what the live route renders", async () => {
    const plan = planClonePreview({
      catalogVoiceId: catalogIdForClone(CLONE_ID),
      text: PREVIEW_TEXT,
    });
    const fromPlan = clonePreviewPathForCatalog(
      {
        id: catalogIdForClone(CLONE_ID),
        providerVoiceId: "fish-ref-wolfe",
        model: "s2.1-pro-free",
      },
      plan,
      PREVIEW_TEXT
    );
    const direct = clonePreviewStoragePath({
      catalogVoiceId: catalogIdForClone(CLONE_ID),
      providerVoiceId: "fish-ref-wolfe",
      model: "s2.1-pro-free",
      script: plan.script,
      speed: plan.speed,
    });
    expect(fromPlan).toBe(direct);
    expect(fromPlan).toMatch(
      new RegExp(`^previews/clones/${CLONE_ID}/[0-9a-f]{32}\\.mp3$`)
    );
    // The plan uses the clone's slow start speed, so the key is not the 1.0x one.
    expect(plan.speed).toBe(0.85);
  });

  it("never stores a take for custom sample text", async () => {
    const plan = planClonePreview({
      catalogVoiceId: catalogIdForClone(CLONE_ID),
      text: "A different line.",
    });
    expect(
      clonePreviewPathForCatalog(
        {
          id: catalogIdForClone(CLONE_ID),
          providerVoiceId: "fish-ref-wolfe",
          model: "s2.1-pro-free",
        },
        plan,
        "A different line."
      )
    ).toBeNull();
  });

  it("derives the same key with or without delivery preferences", () => {
    // `/api/tts/clones/[id]/preview` has no preferences to apply, so the live
    // route must ignore them for a clone's fixed one-liner. If it did not, a
    // saved clip would never be found and every select would synthesize.
    const voice = {
      id: catalogIdForClone(CLONE_ID),
      providerVoiceId: "fish-ref-wolfe",
      model: "s2.1-pro-free",
    };
    const plain = planClonePreview({
      catalogVoiceId: voice.id,
      text: PREVIEW_TEXT,
    });
    const tuned = planClonePreview({
      catalogVoiceId: voice.id,
      text: PREVIEW_TEXT,
      ttsOptions: {
        pauseStyle: "normal",
        normalizeTitles: true,
        deliveryPrefix: true,
      },
    });
    expect(tuned).toEqual(plain);
    expect(clonePreviewPathForCatalog(voice, tuned)).toBe(
      clonePreviewPathForCatalog(voice, plain)
    );
  });

  it("passes delivery preferences through for a stock preview", () => {
    // The exception is scoped to clones: stock previews keep their overrides.
    const prefs = { normalizeTitles: true, pauseStyle: "normal" as const };
    expect(
      previewDeliveryInput("fish-narrator", PREVIEW_TEXT, prefs)
    ).toBe(prefs);
    expect(
      previewDeliveryInput(catalogIdForClone(CLONE_ID), PREVIEW_TEXT, prefs)
    ).toBeUndefined();
    // Custom sample text is not the stored one-liner, so prefs still apply.
    expect(
      previewDeliveryInput(catalogIdForClone(CLONE_ID), "Other line.", prefs)
    ).toBe(prefs);
  });

  it("treats a silent stored object as no preview", async () => {
    const plan = planClonePreview({
      catalogVoiceId: catalogIdForClone(CLONE_ID),
      text: PREVIEW_TEXT,
    });
    const storagePath = clonePreviewPathForCatalog(
      {
        id: catalogIdForClone(CLONE_ID),
        providerVoiceId: "fish-ref-wolfe",
        model: "s2.1-pro-free",
      },
      plan
    )!;
    // A zero-filled object is the classic provider failure, and must not be
    // served as if it were a take.
    const slash = storagePath.lastIndexOf("/");
    await uploadFile(
      storagePath.slice(0, slash),
      storagePath.slice(slash + 1),
      Buffer.alloc(4096, 0),
      "audio/mpeg"
    );
    expect(await storedClonePreviewAudio(storagePath)).toBeNull();

    const { GET: preview } = await import(
      "@/app/api/tts/clones/[id]/preview/route"
    );
    const res = await preview(
      await previewRequest(CLONE_ID, USER_A),
      routeParams({ id: CLONE_ID })
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("PREVIEW_NOT_STORED");
  });

  it("returns 503 when cloning is not configured", async () => {
    delete process.env.FISH_API_KEY;
    const { GET: preview } = await import(
      "@/app/api/tts/clones/[id]/preview/route"
    );
    const res = await preview(
      await previewRequest(CLONE_ID, USER_A),
      routeParams({ id: CLONE_ID })
    );
    expect(res.status).toBe(503);
  });
});
