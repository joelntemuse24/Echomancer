/**
 * A saved clone's preview must never sit through a cold model start.
 *
 * The production report (2026-11-06, VDH clone `e552d5a5`): tapping play on a
 * saved clone showed nothing for about two minutes. The evidence was a single
 * `POST /api/tts/clones/<id>/preview` that **hit Vercel's 60 s function limit**,
 * and a preview object first appearing on disk minutes later. The old code path
 * explained it exactly:
 *
 *   1. `POST` called `provider.synthesize` → the S2 adapter, whose cold branch
 *      waits up to `MODAL_S2_COLD_WAIT_MS` (150 s) for a snapshot restore.
 *   2. Vercel kills the function at 60 s, so that wait cannot finish.
 *   3. The GPU still rendered the line, but the request was already dead, so
 *      nothing was stored under the key the client needed.
 *   4. The next tap repeated all of it.
 *
 * The request route no longer renders. These tests pin the worker bake:
 *
 *   - a stored clip is served with **no** provider call at all;
 *   - a missing clip is baked by Fish (`reference_id` of this clone) and
 *     stored under the fish key, even when the S2 pool is cold or unprobed;
 *   - that bake does not call a Modal host and does not start a restore;
 *   - concurrent bakes share one Fish call;
 *   - a failure is terminal until Retry, and Retry waits out the backoff.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USER_A, buildRequest, resetDatabase, routeParams } from "@/test/harness";
import { insertClonedVoice } from "@/lib/turso/cloned-voices";
import { catalogIdForClone } from "@/lib/tts/fish-clone";
import { clonePreviewWritePath, planClonePreview } from "@/lib/tts/clone-preview";
import {
  clonePreviewStoragePath,
  legacyClonePreviewStoragePath,
  readStoredClonePreview,
} from "@/lib/tts/clone-preview-store";
import { PREVIEW_TEXT } from "@/lib/tts/preview-text";
import { uploadFile } from "@/lib/storage";
import { resetModalCloneRuntimeForTests } from "@/lib/tts/providers/modal-clone";
import {
  resetModalCloneWarmForTests,
  setModalCloneWarmSpawnerForTests,
} from "@/lib/tts/providers/modal-clone-warm";
import {
  CLONE_PREVIEW_BACKOFF_MS,
  resetClonePreviewBakeForTests,
  setClonePreviewNowForTests,
} from "@/lib/tts/clone-preview-job";

const CLONE_ID = "e552d5a5-8f2f-484d-9399-800ddacba85c";
const BATCH_HOST = "https://acme--echomancer-s2-clone-synthesize-batch.modal.run";
const READY_HOST = "https://acme--echomancer-s2-clone-ready.modal.run";

function fakeMp3(fill: number): Buffer {
  const bytes = Buffer.alloc(4096, fill);
  bytes[0] = 0xff;
  bytes[1] = 0xfb;
  return bytes;
}

async function makeClone(userId = USER_A, fishVoiceId = "fish-ref-vdh") {
  const clone = await insertClonedVoice({
    id: CLONE_ID,
    userId,
    fishVoiceId,
    title: "Victor Davis Hanson",
    state: "trained",
    model: "s2.1-pro-free",
    sampleStoragePath: `clones/${CLONE_ID}/sample.wav`,
  });
  // The adapter loads the reference before it posts, so the sample has to exist
  // in the harness storage or every render fails before the mocked network.
  await putObject(`clones/${CLONE_ID}/sample.wav`, fakeMp3(3));
  return clone;
}

function voiceOf(clone: { id: string; fish_voice_id: string; model: string }) {
  return {
    id: catalogIdForClone(clone.id),
    providerVoiceId: clone.fish_voice_id,
    model: clone.model,
  };
}

function planFor(clone: { id: string }) {
  return planClonePreview({ catalogVoiceId: catalogIdForClone(clone.id), text: PREVIEW_TEXT });
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

/** Every outbound call, tagged so a test can assert on which host was hit. */
type Call = { url: string; method: string; body: unknown };

function recordFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: (init?.method || "GET").toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn, synthesisCalls: () => calls.filter((c) => c.method === "POST") };
}

function fishMp3(fill = 9) {
  return new Response(fakeMp3(fill), {
    status: 200,
    headers: { "content-type": "audio/mpeg" },
  });
}

function configureModal() {
  process.env.MODAL_S2_TTS_URL = BATCH_HOST;
  process.env.MODAL_S2_READY_URL = READY_HOST;
  process.env.MODAL_S2_TOKEN = "test-token";
  delete process.env.MODAL_S2_SYNTHESIZE_URL;
}

function previewRequest(method: "GET" | "POST") {
  return buildRequest(`/api/tts/clones/${CLONE_ID}/preview`, {
    userId: USER_A,
    method,
    ...(method === "POST" ? { body: {} } : {}),
  });
}

async function route() {
  return import("@/app/api/tts/clones/[id]/preview/route");
}

beforeEach(async () => {
  await resetDatabase();
  process.env.FISH_API_KEY = "test-key";
  resetModalCloneRuntimeForTests();
  resetModalCloneWarmForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.FISH_API_KEY;
  delete process.env.MODAL_S2_TTS_URL;
  delete process.env.MODAL_S2_TOKEN;
  delete process.env.MODAL_S2_READY_URL;
  delete process.env.MODAL_S2_SYNTHESIZE_URL;
  delete process.env.CLONE_TTS_PROVIDER;
  delete process.env.WORKER_URL;
  delete process.env.WORKER_SECRET;
  resetModalCloneRuntimeForTests();
  resetModalCloneWarmForTests();
  resetClonePreviewBakeForTests();
});

describe("a stored preview is a storage read", () => {
  it("serves the S2 take with zero outbound calls", async () => {
    const clone = await makeClone();
    configureModal();
    const stored = fakeMp3(11);
    await putObject(
      clonePreviewWritePath(voiceOf(clone), planFor(clone), PREVIEW_TEXT, "s2-pro")!,
      stored
    );
    const { calls } = recordFetch(() => {
      throw new Error("no outbound call may happen for a stored preview");
    });

    const { GET } = await route();
    const res = await GET(await previewRequest("GET"), routeParams({ id: clone.id }));

    expect(res.status).toBe(200);
    expect(res.headers.get("x-echomancer-preview")).toBe("stored");
    expect(Buffer.from(await res.arrayBuffer()).equals(stored)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("serves the legacy Fish 2.1 take when that is all there is", async () => {
    // The pre-S2 object is this voice on the model that trained the reference,
    // so it is preferred over paying a GPU restore to re-render the same line.
    const clone = await makeClone();
    const plan = planFor(clone);
    const legacy = legacyClonePreviewStoragePath({
      catalogVoiceId: catalogIdForClone(clone.id),
      providerVoiceId: clone.fish_voice_id,
      model: clone.model,
      script: plan.script,
      speed: plan.speed,
    })!;
    const stored = fakeMp3(5);
    await putObject(legacy, stored);
    configureModal();
    const { calls } = recordFetch(() => {
      throw new Error("legacy preview must not synthesize");
    });

    const { GET } = await route();
    const res = await GET(await previewRequest("GET"), routeParams({ id: clone.id }));
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(stored)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("serves a take rendered by the other legitimate engine", async () => {
    // A clone that previously previewed on direct Fish now books on S2. The Fish
    // take is the same voice, so it must be found rather than re-rendered.
    const clone = await makeClone();
    const fishPath = clonePreviewStoragePath(
      {
        catalogVoiceId: catalogIdForClone(clone.id),
        providerVoiceId: clone.fish_voice_id,
        model: clone.model,
        script: planFor(clone).script,
        speed: planFor(clone).speed,
      },
      "fish"
    )!;
    const stored = fakeMp3(7);
    await putObject(fishPath, stored);
    configureModal();

    const { GET } = await route();
    const res = await GET(await previewRequest("GET"), routeParams({ id: clone.id }));
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(stored)).toBe(true);
  });
});

describe("a cold S2 pool does not block the Fish preview", () => {
  function fishKey(clone: { id: string; fish_voice_id: string; model: string }) {
    const voice = voiceOf(clone);
    const plan = planFor(clone);
    return clonePreviewWritePath(voice, plan, PREVIEW_TEXT, "fish")!;
  }

  it("bakes through Fish and stores only the fish key", async () => {
    const clone = await makeClone();
    configureModal();
    delete process.env.MODAL_S2_READY_URL;
    const spawned: string[][] = [];
    setModalCloneWarmSpawnerForTests((command, args) => {
      spawned.push([command, ...args]);
    });
    const { calls } = recordFetch((call) => {
      if (call.url.includes("modal.run")) {
        return new Response("upstream unavailable", { status: 503 });
      }
      return fishMp3(13);
    });

    const { bakeClonePreview } = await import("@/lib/tts/clone-preview-job");
    const res = await bakeClonePreview(clone.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-echomancer-preview")).toBe("generated");
    const bytes = Buffer.from(await res.arrayBuffer());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.fish.audio/v1/tts");
    expect((calls[0]!.body as { reference_id?: string }).reference_id).toBe("fish-ref-vdh");
    expect(JSON.stringify(calls[0]!.body)).not.toMatch(/drama/i);
    expect(spawned).toHaveLength(0);

    const fishPath = fishKey(clone);
    const s2Path = clonePreviewWritePath(voiceOf(clone), planFor(clone), PREVIEW_TEXT, "s2-pro")!;
    expect((await readStoredClonePreview(fishPath))?.equals(bytes)).toBe(true);
    expect(await readStoredClonePreview(s2Path)).toBeNull();

    const { GET } = await route();
    const replay = await GET(await previewRequest("GET"), routeParams({ id: clone.id }));
    expect(replay.status).toBe(200);
    expect(replay.headers.get("x-echomancer-preview")).toBe("stored");
    expect(calls).toHaveLength(1);
  });

  it("does not render on Play when a bake is already claimed", async () => {
    const clone = await makeClone();
    configureModal();
    process.env.WORKER_URL = "https://worker.test";
    process.env.WORKER_SECRET = "worker-secret";
    const { calls } = recordFetch(() => new Response("{}", { status: 202 }));
    const { GET } = await route();
    const first = await GET(await previewRequest("GET"), routeParams({ id: clone.id }));
    const second = await GET(await previewRequest("GET"), routeParams({ id: clone.id }));
    expect(first.status).toBe(202);
    expect((await first.json()).code).toBe("PREVIEW_PREPARING");
    expect(second.status).toBe(202);
    expect((await second.json()).code).toBe("PREVIEW_PREPARING");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://worker.test/clone-preview");
  });

  it("shares one Fish call across overlapping bakes", async () => {
    const clone = await makeClone();
    configureModal();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls } = recordFetch(async (call) => {
      if (call.url.includes("modal.run")) {
        return new Response("cold", { status: 503 });
      }
      await gate;
      return fishMp3(17);
    });
    const { bakeClonePreview } = await import("@/lib/tts/clone-preview-job");
    const first = bakeClonePreview(clone.id);
    const second = bakeClonePreview(clone.id);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(calls.filter((call) => call.url.includes("fish.audio"))).toHaveLength(1);
  });

  it("stops after one failure until Retry's backoff has elapsed", async () => {
    const clone = await makeClone();
    configureModal();
    let now = 1_700_000_000_000;
    setClonePreviewNowForTests(() => now);
    let attempts = 0;
    const { calls } = recordFetch(() => {
      attempts += 1;
      if (attempts === 1) return new Response("no", { status: 422 });
      return fishMp3(4);
    });
    const { bakeClonePreview } = await import("@/lib/tts/clone-preview-job");
    const failed = await bakeClonePreview(clone.id);
    expect(failed.status).toBe(409);
    expect((await failed.json()).code).toBe("PREVIEW_BAKE_FAILED");
    expect(calls).toHaveLength(1);

    const again = await bakeClonePreview(clone.id);
    expect(again.status).toBe(409);
    expect(calls).toHaveLength(1);

    const early = await bakeClonePreview(clone.id, { force: true });
    expect(early.status).toBe(409);
    expect((await early.json()).retryAfterMs).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);

    now += CLONE_PREVIEW_BACKOFF_MS[0];
    const retried = await bakeClonePreview(clone.id, { force: true });
    expect(retried.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.url.includes("fish.audio"))).toBe(true);
    expect(
      await readStoredClonePreview(
        clonePreviewWritePath(voiceOf(clone), planFor(clone), PREVIEW_TEXT, "s2-pro")!
      )
    ).toBeNull();
    expect(await readStoredClonePreview(fishKey(clone))).not.toBeNull();
  });

  it("answers Play with the failure and does not enqueue again", async () => {
    const clone = await makeClone();
    let now = 1_700_000_000_000;
    setClonePreviewNowForTests(() => now);
    recordFetch(() => new Response("no", { status: 500 }));
    const { bakeClonePreview } = await import("@/lib/tts/clone-preview-job");
    await bakeClonePreview(clone.id);

    const { calls } = recordFetch(() => {
      throw new Error("a failed preview must not bake again on GET");
    });
    const { GET, POST } = await route();
    const get = await GET(await previewRequest("GET"), routeParams({ id: clone.id }));
    expect(get.status).toBe(409);
    expect((await get.json()).code).toBe("PREVIEW_BAKE_FAILED");

    const post = await POST(
      await buildRequest(`/api/tts/clones/${CLONE_ID}/preview`, {
        userId: USER_A,
        method: "POST",
        body: { retry: true },
      }),
      routeParams({ id: clone.id })
    );
    expect(post.status).toBe(409);
    expect(calls).toHaveLength(0);

    now += CLONE_PREVIEW_BACKOFF_MS[0];
    const later = await POST(
      await buildRequest(`/api/tts/clones/${CLONE_ID}/preview`, {
        userId: USER_A,
        method: "POST",
        body: { retry: true },
      }),
      routeParams({ id: clone.id })
    );
    expect(later.status).toBe(202);
    expect(calls.filter((call) => String(call.url).includes("fish.audio"))).toHaveLength(0);
  });

  it("asks the worker once when a clone is created", async () => {
    const clone = await makeClone();
    process.env.WORKER_URL = "https://worker.test";
    process.env.WORKER_SECRET = "worker-secret";
    const { calls } = recordFetch(() => new Response("{}", { status: 202 }));
    const { enqueueClonePreviewBake } = await import("@/lib/tts/clone-preview-job");
    await enqueueClonePreviewBake(catalogIdForClone(clone.id));
    await enqueueClonePreviewBake(catalogIdForClone(clone.id));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://worker.test/clone-preview");
    expect((calls[0]!.body as { force?: boolean }).force).toBe(false);
    expect(calls[0]!.url).not.toContain("fish.audio");
  });

  it("does not enqueue again when the worker rejects the bake", async () => {
    const clone = await makeClone();
    process.env.WORKER_URL = "https://worker.test";
    process.env.WORKER_SECRET = "worker-secret";
    const { calls } = recordFetch(() => new Response("no", { status: 500 }));
    const { GET } = await route();
    const first = await GET(await previewRequest("GET"), routeParams({ id: clone.id }));
    expect(first.status).toBe(409);
    expect((await first.json()).code).toBe("PREVIEW_BAKE_FAILED");

    const again = await GET(await previewRequest("GET"), routeParams({ id: clone.id }));
    expect(again.status).toBe(409);
    const poll = await GET(
      await buildRequest(`/api/tts/clones/${CLONE_ID}/preview?poll=1`, {
        userId: USER_A,
        method: "GET",
      }),
      routeParams({ id: clone.id })
    );
    expect(poll.status).toBe(409);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://worker.test/clone-preview");
    expect(calls.every((call) => !call.url.includes("fish.audio"))).toBe(true);
    expect(calls.every((call) => !call.url.includes("modal.run"))).toBe(true);
  });

  it("a poll never starts a bake", async () => {
    const clone = await makeClone();
    process.env.WORKER_URL = "https://worker.test";
    process.env.WORKER_SECRET = "worker-secret";
    const { calls } = recordFetch(() => new Response("{}", { status: 202 }));
    const { GET } = await route();
    const poll = await GET(
      await buildRequest(`/api/tts/clones/${clone.id}/preview?poll=1`, {
        userId: USER_A,
        method: "GET",
      }),
      routeParams({ id: clone.id })
    );
    expect(poll.status).toBe(409);
    expect((await poll.json()).code).toBe("PREVIEW_BAKE_FAILED");
    expect(calls).toHaveLength(0);
  });

  it("lets the first Play bake after a create enqueue was not accepted", async () => {
    const clone = await makeClone();
    process.env.WORKER_URL = "https://worker.test";
    process.env.WORKER_SECRET = "worker-secret";
    let posts = 0;
    const { calls } = recordFetch(() => {
      posts += 1;
      return new Response(posts === 1 ? "no" : "{}", { status: posts === 1 ? 500 : 202 });
    });
    const { enqueueClonePreviewBake } = await import("@/lib/tts/clone-preview-job");
    await enqueueClonePreviewBake(catalogIdForClone(clone.id));
    expect(calls).toHaveLength(1);

    const { GET } = await route();
    const play = await GET(await previewRequest("GET"), routeParams({ id: clone.id }));
    expect(play.status).toBe(202);
    expect(calls).toHaveLength(2);

    const poll = await GET(
      await buildRequest(`/api/tts/clones/${CLONE_ID}/preview?poll=1`, {
        userId: USER_A,
        method: "GET",
      }),
      routeParams({ id: clone.id })
    );
    expect(poll.status).toBe(202);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.url === "https://worker.test/clone-preview")).toBe(true);
  });

  it("keeps a retry refused by the worker clock from being started again", async () => {
    const clone = await makeClone();
    configureModal();
    process.env.WORKER_URL = "https://worker.test";
    process.env.WORKER_SECRET = "worker-secret";
    let now = 1_700_000_000_000;
    setClonePreviewNowForTests(() => now);
    const { calls } = recordFetch((call) => {
      if (call.url.includes("worker.test")) return new Response("{}", { status: 202 });
      if (call.url.includes("modal.run")) return new Response("cold", { status: 503 });
      return new Response("no", { status: 422 });
    });
    const { bakeClonePreview, claimClonePreviewBake } = await import(
      "@/lib/tts/clone-preview-job"
    );
    const failed = await bakeClonePreview(clone.id);
    expect(failed.status).toBe(409);
    expect(calls.filter((call) => call.url.includes("fish.audio"))).toHaveLength(1);

    now += CLONE_PREVIEW_BACKOFF_MS[0];
    const claim = await claimClonePreviewBake(catalogIdForClone(clone.id), { force: true });
    expect(claim.kind).toBe("start");
    now -= 1_000;
    const refused = await bakeClonePreview(clone.id, { force: true });
    expect(refused.status).toBe(409);
    expect(calls.filter((call) => call.url.includes("fish.audio"))).toHaveLength(1);

    now += 1_000;
    const { GET } = await route();
    const play = await GET(await previewRequest("GET"), routeParams({ id: clone.id }));
    expect(play.status).toBe(409);
    const poll = await GET(
      await buildRequest(`/api/tts/clones/${CLONE_ID}/preview?poll=1`, {
        userId: USER_A,
        method: "GET",
      }),
      routeParams({ id: clone.id })
    );
    expect(poll.status).toBe(409);
    expect(calls.filter((call) => call.url.includes("worker.test"))).toHaveLength(0);
    expect(calls.filter((call) => call.url.includes("modal.run"))).toHaveLength(0);
  });
});
