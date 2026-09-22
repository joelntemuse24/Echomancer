import { beforeEach, describe, expect, it } from "vitest";
import { insertClonedVoice } from "@/lib/turso/cloned-voices";
import { USER_A, USER_B, buildRequest, resetDatabase, routeParams } from "@/test/harness";

const CLONE_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(async () => {
  await resetDatabase();
  await insertClonedVoice({
    id: CLONE_ID,
    userId: USER_A,
    fishVoiceId: "fish-shauna",
    title: "Shauna",
    state: "trained",
    model: "s2.1-pro-free",
  });
});

describe("PATCH /api/tts/clones/[id]", () => {
  it("relabels an existing clone to British without retraining", async () => {
    const { PATCH } = await import("@/app/api/tts/clones/[id]/route");
    const response = await PATCH(
      await buildRequest(`/api/tts/clones/clone:${CLONE_ID}`, {
        method: "PATCH",
        userId: USER_A,
        body: { accent: "british" },
      }),
      routeParams({ id: `clone:${CLONE_ID}` })
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.clone.displayName).toBe("Shauna · British");
    expect(body.clone.locale).toBe("en-GB");
    expect(body.clone.accent).toBe("british");
    expect(body.clone.accentHint).toBe("british");
    expect(body.clone.catalogVoiceId).toBe(`clone:${CLONE_ID}`);
  });

  it("reports another session's clone as 404", async () => {
    const { PATCH } = await import("@/app/api/tts/clones/[id]/route");
    const response = await PATCH(
      await buildRequest(`/api/tts/clones/${CLONE_ID}`, {
        method: "PATCH",
        userId: USER_B,
        body: { accent: "british" },
      }),
      routeParams({ id: CLONE_ID })
    );
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("NOT_FOUND");
  });

  it("rejects an unknown accent", async () => {
    const { PATCH } = await import("@/app/api/tts/clones/[id]/route");
    const response = await PATCH(
      await buildRequest(`/api/tts/clones/${CLONE_ID}`, {
        method: "PATCH",
        userId: USER_A,
        body: { accent: "martian" },
      }),
      routeParams({ id: CLONE_ID })
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("INVALID_BODY");
  });
});
