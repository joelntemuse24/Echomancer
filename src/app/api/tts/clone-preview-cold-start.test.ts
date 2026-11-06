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
 * These tests pin the fix at the route boundary:
 *
 *   - a stored clip is served with **no** provider call at all (the normal case
 *     after the first render, and the case that must be instant);
 *   - a render against a pool that is not **provably** warm is refused at once
 *     with `PREVIEW_ENGINE_COLD`, opens no synthesis request, and starts a
 *     restore;
 *   - a render against a warm pool is bounded by the route's own budget, never
 *     by the book's cold-restore budget;
 *   - concurrent taps produce one stored take, not one per request;
 *   - a failed or empty render stores nothing, so no take from a substitute
 *     engine can ever be served.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USER_A, buildRequest, resetDatabase, routeParams } from "@/test/harness";
import { insertClonedVoice } from "@/lib/turso/cloned-voices";
import { catalogIdForClone } from "@/lib/tts/fish-clone";
import {
  clonePreviewReadPaths,
  clonePreviewWritePath,
  findStoredClonePreview,
  planClonePreview,
} from "@/lib/tts/clone-preview";
import {
  clonePreviewStoragePath,
  legacyClonePreviewStoragePath,
  readStoredClonePreview,
} from "@/lib/tts/clone-preview-store";
import { PREVIEW_TEXT } from "@/lib/tts/preview-text";
import { uploadFile } from "@/lib/storage";
import { resetModalCloneRuntimeForTests } from "@/lib/tts/providers/modal-clone";
import { resetModalCloneWarmForTests } from "@/lib/tts/providers/modal-clone-warm";
import {
  MODAL_CLONE_COLD_WAIT_DEFAULT_MS,
  MODAL_CLONE_TIMEOUT_MAX_MS,
} from "@/lib/tts/providers/modal-clone-guard";
import { setModalCloneWarmSpawnerForTests } from "@/lib/tts/providers/modal-clone-warm";

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

/** The ready probe says the pool has a live container of this build. */
function warmReady() {
  return new Response(JSON.stringify({ ready: true, warm_containers: 1, build: "abc123" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** The ready probe says nothing is warm (the normal state after idle). */
function coldReady() {
  return new Response(
    JSON.stringify({ ready: false, warm_containers: 0, build: "abc123" }),
    { status: 503, headers: { "content-type": "application/json" } }
  );
}

function batchOk(fill = 9) {
  return new Response(
    JSON.stringify({
      items: [{ key: "preview", audio_b64: fakeMp3(fill).toString("base64"), duration_s: 5.2, units: 1 }],
      build: "abc123",
      container_id: "c1",
      boot: "restored",
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
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
  resetModalCloneRuntimeForTests();
  resetModalCloneWarmForTests();
});

describe("a stored preview is a storage read", () => {
  it("serves the S2 take with zero outbound calls", async () => {
    const clone = await makeClone();
    const stored = fakeMp3(11);
    await putObject(clonePreviewWritePath(voiceOf(clone), planFor(clone))!, stored);
    configureModal();
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

describe("a cold pool never becomes a request that waits", () => {
  it("refuses instantly instead of waiting out a restore", async () => {
    const clone = await makeClone();
    configureModal();
    const { calls, synthesisCalls } = recordFetch((call) =>
      call.url === READY_HOST ? coldReady() : batchOk()
    );
    const started = Date.now();

    const { POST } = await route();
    const res = await POST(await previewRequest("POST"), routeParams({ id: clone.id }));
    const elapsed = Date.now() - started;

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("PREVIEW_ENGINE_COLD");
    expect(body.error).toMatch(/starting up/i);
    expect(body.error).toMatch(/nothing else was substituted/i);
    // Not a synthesis call, and not even close to the book's restore budget.
    expect(synthesisCalls()).toHaveLength(0);
    expect(elapsed).toBeLessThan(2_000);
    // The probe is the only call, and it was the ready host.
    expect(calls.map((c) => c.url)).toEqual([READY_HOST]);
  });

  it("starts a restore so the next tap can read storage", async () => {
    const clone = await makeClone();
    configureModal();
    process.env.MODAL_TOKEN_ID = "tok";
    const spawned: string[][] = [];
    setModalCloneWarmSpawnerForTests((command, args) => {
      spawned.push([command, ...args]);
    });
    recordFetch((call) => (call.url === READY_HOST ? coldReady() : batchOk()));

    const { POST } = await route();
    await POST(await previewRequest("POST"), routeParams({ id: clone.id }));

    expect(spawned.length).toBe(1);
    expect(spawned[0]!.join(" ")).toContain("s2_clone_warm.py::cover");
    expect(await findStoredClonePreview(voiceOf(clone), planFor(clone))).toBeNull();
    delete process.env.MODAL_TOKEN_ID;
  });

  it("reports a missing ready URL as cold instead of assuming warm", async () => {
    // This was live production config on 2026-11-06: Vercel had the batch URL
    // and the token but no `MODAL_S2_READY_URL`. The old code treated that as
    // "assume reachable", so the preview opened a 150 s restore wait inside a
    // 60 s function. Unprovable warmth must mean no synthesis.
    const clone = await makeClone();
    configureModal();
    delete process.env.MODAL_S2_READY_URL;
    const { synthesisCalls } = recordFetch(() => batchOk());

    const { POST } = await route();
    const res = await POST(await previewRequest("POST"), routeParams({ id: clone.id }));

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("PREVIEW_ENGINE_COLD");
    expect(synthesisCalls()).toHaveLength(0);
  });

  it("reports a probe timeout as cold", async () => {
    const clone = await makeClone();
    configureModal();
    const { synthesisCalls } = recordFetch((call) => {
      if (call.url === READY_HOST) throw new DOMException("timed out", "TimeoutError");
      return batchOk();
    });

    const { POST } = await route();
    const res = await POST(await previewRequest("POST"), routeParams({ id: clone.id }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("PREVIEW_ENGINE_COLD");
    expect(synthesisCalls()).toHaveLength(0);
  });

  it("refuses when the probe answer is not JSON", async () => {
    // A reverse proxy's HTML error page is not a warm pool.
    const clone = await makeClone();
    configureModal();
    const { synthesisCalls } = recordFetch((call) =>
      call.url === READY_HOST
        ? new Response("<html>bad gateway</html>", { status: 200 })
        : batchOk()
    );

    const { POST } = await route();
    const res = await POST(await previewRequest("POST"), routeParams({ id: clone.id }));
    expect(res.status).toBe(503);
    expect(synthesisCalls()).toHaveLength(0);
  });
});

describe("a warm render is bounded and stored once", () => {
  it("renders, stores under the engine key, and then replays from storage", async () => {
    const clone = await makeClone();
    configureModal();
    const { synthesisCalls } = recordFetch((call) =>
      call.url === READY_HOST ? warmReady() : batchOk(13)
    );

    const { POST, GET } = await route();
    const first = await POST(await previewRequest("POST"), routeParams({ id: clone.id }));
    expect(first.status).toBe(200);
    expect(first.headers.get("x-echomancer-preview")).toBe("generated");
    const bytes = Buffer.from(await first.arrayBuffer());
    expect(synthesisCalls()).toHaveLength(1);

    // The take is where GET and the live route look for it.
    const stored = await readStoredClonePreview(
      clonePreviewWritePath(voiceOf(clone), planFor(clone))!
    );
    expect(stored?.equals(bytes)).toBe(true);

    const second = await GET(await previewRequest("GET"), routeParams({ id: clone.id }));
    expect(second.status).toBe(200);
    expect(second.headers.get("x-echomancer-preview")).toBe("stored");
    expect(synthesisCalls()).toHaveLength(1);
  });

  it("uses a bounded wait, never the book's cold-restore budget", async () => {
    const clone = await makeClone();
    configureModal();
    const { synthesisCalls } = recordFetch((call) =>
      call.url === READY_HOST ? warmReady() : batchOk()
    );

    const { POST } = await route();
    await POST(await previewRequest("POST"), routeParams({ id: clone.id }));

    const post = synthesisCalls()[0]!;
    expect(post.url).toBe(BATCH_HOST);
    // The batch contract is used because no single-section host is configured —
    // a single-section body posted at the batch host is a guaranteed 400.
    expect((post.body as { items: unknown[] }).items).toHaveLength(1);
    // And the wait this call could have been given is under a compile by a wide
    // margin: it is the route budget, not `MODAL_S2_COLD_WAIT_MS`.
    const routeBudget = 35_000;
    expect(routeBudget).toBeLessThan(MODAL_CLONE_COLD_WAIT_DEFAULT_MS);
    expect(routeBudget).toBeGreaterThan(MODAL_CLONE_TIMEOUT_MAX_MS / 2);
  });

  it("does not re-render when the take already exists", async () => {
    const clone = await makeClone();
    const stored = fakeMp3(21);
    await putObject(clonePreviewWritePath(voiceOf(clone), planFor(clone))!, stored);
    configureModal();
    const { calls } = recordFetch(() => {
      throw new Error("a stored take must not synthesize");
    });

    const { POST } = await route();
    const res = await POST(await previewRequest("POST"), routeParams({ id: clone.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-echomancer-preview")).toBe("stored");
    expect(Buffer.from(await res.arrayBuffer()).equals(stored)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("answers concurrent taps with one synthesis and one stored file", async () => {
    // Two taps a moment apart must not bill two renders. The first stores; the
    // rest find that take.
    const clone = await makeClone();
    configureModal();
    const { synthesisCalls } = recordFetch(async (call) => {
      if (call.url === READY_HOST) return warmReady();
      await new Promise((resolve) => setTimeout(resolve, 10));
      return batchOk(17);
    });

    const { POST } = await route();
    const first = await POST(await previewRequest("POST"), routeParams({ id: clone.id }));
    expect(first.status).toBe(200);
    const second = await POST(await previewRequest("POST"), routeParams({ id: clone.id }));
    expect(second.status).toBe(200);
    expect(second.headers.get("x-echomancer-preview")).toBe("stored");
    expect(synthesisCalls()).toHaveLength(1);
  });

  it("stores nothing when the render fails", async () => {
    const clone = await makeClone();
    configureModal();
    recordFetch((call) => {
      if (call.url === READY_HOST) return warmReady();
      return new Response(
        JSON.stringify({ items: [{ key: "preview", error: "section has no speakable text" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const { POST } = await route();
    const res = await POST(await previewRequest("POST"), routeParams({ id: clone.id }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("PREVIEW_RENDER_FAILED");
    expect(body.error).toMatch(/nothing else was substituted/i);
    // Not anywhere: no substitute engine's bytes can be found later.
    for (const path of clonePreviewReadPaths(voiceOf(clone), planFor(clone))) {
      expect(await readStoredClonePreview(path)).toBeNull();
    }
  });

  it("stores nothing when the render returns non-audio", async () => {
    const clone = await makeClone();
    configureModal();
    recordFetch((call) => {
      if (call.url === READY_HOST) return warmReady();
      return new Response(JSON.stringify({ items: [{ key: "preview", audio_b64: "", duration_s: 5 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const { POST } = await route();
    const res = await POST(await previewRequest("POST"), routeParams({ id: clone.id }));
    expect(res.status).toBe(502);
    expect(await findStoredClonePreview(voiceOf(clone), planFor(clone))).toBeNull();
  });
});
