/**
 * Saved clone previews live in storage; the live route only reads them.
 *
 * The split this file pins:
 *
 *   - `GET /api/tts/clones/[id]/preview` answers from storage or says
 *     `PREVIEW_NOT_STORED`. It never synthesizes.
 *   - `POST` to the same route renders once, on the clone's own engine, and
 *     stores the take.
 *   - `GET /api/tts/live` *serves* a stored preview when one exists, and
 *     otherwise streams — but it never stores. Storage is written in exactly
 *     one place, so a take from an unintended engine cannot end up under a
 *     clone's key. That is what happened on 2026-11-06: a Drama fallback render
 *     was written under an S2 key and then served as "the S2 preview".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USER_A, USER_B, buildRequest, resetDatabase, routeParams } from "@/test/harness";
import { insertClonedVoice } from "@/lib/turso/cloned-voices";
import { catalogIdForClone } from "@/lib/tts/fish-clone";
import {
  clonePreviewStoragePath,
  legacyClonePreviewStoragePath,
  readStoredClonePreview,
} from "@/lib/tts/clone-preview-store";
import { uploadFile } from "@/lib/storage";
import {
  clonePreviewReadPaths,
  clonePreviewWritePath,
  planClonePreview,
} from "@/lib/tts/clone-preview";
import { PREVIEW_TEXT } from "@/lib/tts/preview-text";

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

/** Write bytes at a storage key, as an earlier render would have. */
async function putObject(storagePath: string, bytes: Buffer) {
  const slash = storagePath.lastIndexOf("/");
  await uploadFile(
    storagePath.slice(0, slash),
    storagePath.slice(slash + 1),
    bytes,
    "audio/mpeg"
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.FISH_API_KEY;
  delete process.env.MODAL_S2_TTS_URL;
  delete process.env.MODAL_S2_TOKEN;
});

beforeEach(async () => {
  await resetDatabase();
  process.env.FISH_API_KEY = "test-key";
});

describe("clone preview keys", () => {
  const base = {
    catalogVoiceId: "clone:abc-123",
    providerVoiceId: "fish-ref-a",
    model: "s2.1-pro-free",
    script: "Hello there.",
    speed: 0.85,
  };

  it("keys the file on engine, reference, model, speed and script", () => {
    const path = clonePreviewStoragePath(base, "s2-pro")!;
    expect(path).toMatch(/^previews\/clones\/abc-123\/[0-9a-f]{32}\.mp3$/);
    expect(clonePreviewStoragePath({ ...base }, "s2-pro")).toBe(path);
    expect(clonePreviewStoragePath({ ...base }, "fish")).not.toBe(path);
    expect(clonePreviewStoragePath({ ...base, providerVoiceId: "fish-ref-b" })).not.toBe(path);
    expect(clonePreviewStoragePath({ ...base, model: "s2-pro" })).not.toBe(path);
    expect(clonePreviewStoragePath({ ...base, speed: 1 })).not.toBe(path);
    expect(clonePreviewStoragePath({ ...base, script: "Other." })).not.toBe(path);
    expect(clonePreviewStoragePath({ ...base, catalogVoiceId: "fish-narrator" })).toBeNull();
    expect(clonePreviewStoragePath({ ...base, catalogVoiceId: "clone:../x" })).toBeNull();
    expect(clonePreviewStoragePath({ ...base, providerVoiceId: "" })).toBeNull();
  });

  it("reproduces the legacy engine-free key so Fish 2.1 previews are reusable", () => {
    const legacy = legacyClonePreviewStoragePath(base);
    expect(legacy).toMatch(/^previews\/clones\/abc-123\/[0-9a-f]{32}\.mp3$/);
    expect(legacy).not.toBe(clonePreviewStoragePath(base, "s2-pro"));
    expect(legacy).not.toBe(clonePreviewStoragePath(base, "fish"));
  });

  it("looks up the current engine first, then the legacy Fish 2.1 file", () => {
    const plan = planClonePreview({
      catalogVoiceId: base.catalogVoiceId,
      text: PREVIEW_TEXT,
    });
    const voice = {
      id: base.catalogVoiceId,
      providerVoiceId: base.providerVoiceId,
      model: base.model,
    };
    const paths = clonePreviewReadPaths(voice, plan);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe(clonePreviewWritePath(voice, plan));
    expect(paths[1]).toMatch(/^previews\/clones\/abc-123\//);
    expect(paths[0]).not.toBe(paths[1]);
  });

  it("treats a missing stored file as no preview", async () => {
    expect(await readStoredClonePreview("previews/clones/none/missing.mp3")).toBeNull();
  });
});

describe("GET /api/tts/live never stores a clone preview", () => {
  it("streams on the first play and writes nothing", async () => {
    const clone = await makeClone(USER_A);
    const fetchMock = fishOk(7);
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("@/app/api/tts/live/route");
    const url = `/api/tts/live?catalogVoiceId=${catalogIdForClone(clone.id)}`;

    const first = await GET(await buildRequest(url, { userId: USER_A, method: "GET" }));
    expect(first.status).toBe(200);
    await first.arrayBuffer();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // No `generated` marker, and no object: the live route is a pass-through.
    expect(first.headers.get("x-echomancer-preview")).toBeNull();
    const plan = planClonePreview({
      catalogVoiceId: catalogIdForClone(clone.id),
      text: PREVIEW_TEXT,
    });
    const voice = {
      id: catalogIdForClone(clone.id),
      providerVoiceId: clone.fish_voice_id,
      model: clone.model,
    };
    for (const path of clonePreviewReadPaths(voice, plan)) {
      expect(await readStoredClonePreview(path)).toBeNull();
    }
  });

  it("serves a legacy Fish 2.1 preview without calling the engine", async () => {
    const clone = await makeClone(USER_A);
    const plan = planClonePreview({
      catalogVoiceId: catalogIdForClone(clone.id),
      text: PREVIEW_TEXT,
    });
    const legacy = legacyClonePreviewStoragePath({
      catalogVoiceId: catalogIdForClone(clone.id),
      providerVoiceId: clone.fish_voice_id,
      model: clone.model,
      script: plan.script,
      speed: plan.speed,
    })!;
    const stored = Buffer.from(fakeMp3(3));
    await putObject(legacy, stored);

    const fetchMock = fishOk(9);
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("@/app/api/tts/live/route");
    const res = await GET(
      await buildRequest(`/api/tts/live?catalogVoiceId=${catalogIdForClone(clone.id)}`, {
        userId: USER_A,
        method: "GET",
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-echomancer-preview")).toBe("stored");
    expect(Buffer.from(await res.arrayBuffer()).equals(stored)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/tts/clones/[id]/preview", () => {
  function previewRequest(id: string, userId: string) {
    return buildRequest(`/api/tts/clones/${id}/preview`, { userId, method: "GET" });
  }

  it("serves the stored S2 take and never synthesizes", async () => {
    const clone = await makeClone(USER_A);
    const plan = planClonePreview({
      catalogVoiceId: catalogIdForClone(clone.id),
      text: PREVIEW_TEXT,
    });
    const voice = {
      id: catalogIdForClone(clone.id),
      providerVoiceId: clone.fish_voice_id,
      model: clone.model,
    };
    const stored = Buffer.from(fakeMp3(11));
    await putObject(clonePreviewWritePath(voice, plan)!, stored);

    const fetchMock = fishOk(1);
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("@/app/api/tts/clones/[id]/preview/route");
    const res = await GET(
      await previewRequest(clone.id, USER_A),
      routeParams({ id: clone.id })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("x-echomancer-preview")).toBe("stored");
    expect(Buffer.from(await res.arrayBuffer()).equals(stored)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves the legacy Fish 2.1 take when one exists", async () => {
    const clone = await makeClone(USER_A);
    const plan = planClonePreview({
      catalogVoiceId: catalogIdForClone(clone.id),
      text: PREVIEW_TEXT,
    });
    const legacy = legacyClonePreviewStoragePath({
      catalogVoiceId: catalogIdForClone(clone.id),
      providerVoiceId: clone.fish_voice_id,
      model: clone.model,
      script: plan.script,
      speed: plan.speed,
    })!;
    const stored = Buffer.from(fakeMp3(5));
    await putObject(legacy, stored);

    const fetchMock = fishOk(1);
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("@/app/api/tts/clones/[id]/preview/route");
    const res = await GET(
      await previewRequest(clone.id, USER_A),
      routeParams({ id: clone.id })
    );
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(stored)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports PREVIEW_NOT_STORED before anything is rendered", async () => {
    const clone = await makeClone(USER_A);
    const fetchMock = fishOk(1);
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("@/app/api/tts/clones/[id]/preview/route");
    const res = await GET(
      await previewRequest(clone.id, USER_A),
      routeParams({ id: clone.id })
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("PREVIEW_NOT_STORED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never serves another session's clone preview", async () => {
    const clone = await makeClone(USER_A);
    const plan = planClonePreview({
      catalogVoiceId: catalogIdForClone(clone.id),
      text: PREVIEW_TEXT,
    });
    const voice = {
      id: catalogIdForClone(clone.id),
      providerVoiceId: clone.fish_voice_id,
      model: clone.model,
    };
    await putObject(clonePreviewWritePath(voice, plan)!, Buffer.from(fakeMp3(2)));

    const { GET } = await import("@/app/api/tts/clones/[id]/preview/route");
    const res = await GET(
      await previewRequest(clone.id, USER_B),
      routeParams({ id: clone.id })
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") || "").toMatch(/json/);
  });

  it("regenerates for a new reference id rather than serving the old take", async () => {
    const clone = await makeClone(USER_A, "fish-ref-old");
    const before = planClonePreview({
      catalogVoiceId: catalogIdForClone(clone.id),
      text: PREVIEW_TEXT,
    });
    const oldVoice = {
      id: catalogIdForClone(clone.id),
      providerVoiceId: "fish-ref-old",
      model: clone.model,
    };
    await putObject(clonePreviewWritePath(oldVoice, before)!, Buffer.from(fakeMp3(4)));

    const { execute } = await import("@/lib/turso");
    await execute("UPDATE cloned_voices SET fish_voice_id = ? WHERE id = ?", [
      "fish-ref-new",
      clone.id,
    ]);

    const fetchMock = fishOk(1);
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("@/app/api/tts/clones/[id]/preview/route");
    const res = await GET(
      await previewRequest(clone.id, USER_A),
      routeParams({ id: clone.id })
    );
    // A different reference is a different voice, so the old file is not it.
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("PREVIEW_NOT_STORED");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
