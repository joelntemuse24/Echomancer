import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  UPLOAD_ID_A,
  buildRequest,
  resetDatabase,
  routeParams,
  seedJob,
  seedUpload,
} from "@/test/harness";
import { execute } from "@/lib/turso";
import { buildFrozenScript, persistFrozenScript } from "@/lib/tts/frozen-script";
import { narrationScriptForSynthesis } from "@/lib/tts/narration-script";

const JOB_A = "aaaaaaaa-0000-4000-8000-0000000000ab";
const OWNER_ID = "user_" + "d".repeat(32);
const OPERATOR_ID = "user_" + "c".repeat(32);
const TAGGED = "[whispering] She whispered the marked line by the quay.";

async function seedUser(id: string, email: string) {
  await execute(
    `INSERT INTO users (id, google_sub, email, name) VALUES (?, ?, ?, ?)`,
    [id, `sub-${id}`, email, "Test"]
  );
}

async function seedFrozenFishJob() {
  const pdfPath = await seedUpload({
    id: UPLOAD_ID_A,
    userId: OWNER_ID,
    text: "Chapter one. ".repeat(20),
  });
  await seedJob({
    id: JOB_A,
    userId: OWNER_ID,
    pdfStoragePath: pdfPath,
    ttsProvider: "fish",
    ttsOptions: { pauseStyle: "sparse", deliveryPrefix: false },
    jobKind: "takehome",
  });
  const built = buildFrozenScript({ rawText: TAGGED, maxChars: 4000 });
  await persistFrozenScript(JOB_A, {
    speakable: TAGGED,
    sections: [{ ...built.sections[0]!, text: TAGGED }],
  });
}

beforeEach(async () => {
  await resetDatabase();
  delete process.env.ECHO_OPERATOR_TOOLS;
  delete process.env.ECHO_OPERATOR_USER_IDS;
  process.env.ECHO_OPERATOR_EMAILS = "operator@example.com";
  await seedUser(OPERATOR_ID, "operator@example.com");
  await seedUser(OWNER_ID, "reader@example.com");
});

afterEach(() => {
  delete process.env.ECHO_OPERATOR_TOOLS;
  delete process.env.ECHO_OPERATOR_EMAILS;
  delete process.env.ECHO_OPERATOR_USER_IDS;
});

describe("GET /api/jobs/[id]/markup", () => {
  it("returns the exact Fish text to the allowlisted operator for a job they do not own", async () => {
    const { GET } = await import("@/app/api/jobs/[id]/markup/route");
    await seedFrozenFishJob();

    const response = await GET(
      await buildRequest(`/api/jobs/${JOB_A}/markup`, { userId: OPERATOR_ID }),
      routeParams({ id: JOB_A })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.speakable).toBe(TAGGED);
    expect(body.sections[0].storedText).toBe(TAGGED);
    expect(body.sections[0].fishText).toBe(
      narrationScriptForSynthesis(TAGGED, "fish", {
        pauseStyle: "sparse",
        deliveryPrefix: false,
      })
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns only the Fish string for one section as text", async () => {
    const { GET } = await import("@/app/api/jobs/[id]/markup/route");
    await seedFrozenFishJob();
    const expected = narrationScriptForSynthesis(TAGGED, "fish", {
      pauseStyle: "sparse",
      deliveryPrefix: false,
    });

    const response = await GET(
      await buildRequest(
        `/api/jobs/${JOB_A}/markup?section=0&format=text`,
        { userId: OPERATOR_ID }
      ),
      routeParams({ id: JOB_A })
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(expected);
  });

  it("hides markup from the signed-in owner", async () => {
    const { GET } = await import("@/app/api/jobs/[id]/markup/route");
    await seedFrozenFishJob();

    const response = await GET(
      await buildRequest(`/api/jobs/${JOB_A}/markup`, { userId: OWNER_ID }),
      routeParams({ id: JOB_A })
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Job not found" });
  });

  it("hides the route with no session", async () => {
    const { GET } = await import("@/app/api/jobs/[id]/markup/route");
    await seedFrozenFishJob();

    const response = await GET(
      await buildRequest(`/api/jobs/${JOB_A}/markup`),
      routeParams({ id: JOB_A })
    );
    expect(response.status).toBe(404);
  });

  it("does not rebuild a missing freeze", async () => {
    const { GET } = await import("@/app/api/jobs/[id]/markup/route");
    const pdfPath = await seedUpload({
      id: UPLOAD_ID_A,
      userId: OWNER_ID,
      text: "A book that was never claimed.",
    });
    await seedJob({
      id: JOB_A,
      userId: OWNER_ID,
      pdfStoragePath: pdfPath,
      ttsProvider: "fish",
    });

    const response = await GET(
      await buildRequest(`/api/jobs/${JOB_A}/markup`, { userId: OPERATOR_ID }),
      routeParams({ id: JOB_A })
    );
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("MARKUP_NOT_FROZEN");

    const owner = await GET(
      await buildRequest(`/api/jobs/${JOB_A}/markup`, { userId: OWNER_ID }),
      routeParams({ id: JOB_A })
    );
    expect(owner.status).toBe(404);
    expect(await owner.json()).toEqual({ error: "Job not found" });
  });

  it("stays hidden in production until the switch is on, and still requires the allowlist", async () => {
    const { GET } = await import("@/app/api/jobs/[id]/markup/route");
    await seedFrozenFishJob();
    const previousNode = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    delete process.env.ECHO_OPERATOR_TOOLS;
    try {
      const hidden = await GET(
        await buildRequest(`/api/jobs/${JOB_A}/markup`, { userId: OPERATOR_ID }),
        routeParams({ id: JOB_A })
      );
      expect(hidden.status).toBe(404);
      expect(await hidden.json()).toEqual({ error: "Job not found" });

      process.env.ECHO_OPERATOR_TOOLS = "1";
      delete process.env.ECHO_OPERATOR_EMAILS;
      const unlisted = await GET(
        await buildRequest(`/api/jobs/${JOB_A}/markup`, { userId: OPERATOR_ID }),
        routeParams({ id: JOB_A })
      );
      expect(unlisted.status).toBe(404);

      process.env.ECHO_OPERATOR_EMAILS = "operator@example.com";
      const open = await GET(
        await buildRequest(`/api/jobs/${JOB_A}/markup`, { userId: OPERATOR_ID }),
        routeParams({ id: JOB_A })
      );
      expect(open.status).toBe(200);

      const owner = await GET(
        await buildRequest(`/api/jobs/${JOB_A}/markup`, { userId: OWNER_ID }),
        routeParams({ id: JOB_A })
      );
      expect(owner.status).toBe(404);
    } finally {
      process.env.NODE_ENV = previousNode;
    }
  });

  it("accepts ECHO_OPERATOR_USER_IDS when email is unset", async () => {
    const { GET } = await import("@/app/api/jobs/[id]/markup/route");
    await seedFrozenFishJob();
    delete process.env.ECHO_OPERATOR_EMAILS;
    process.env.ECHO_OPERATOR_USER_IDS = OPERATOR_ID;

    const response = await GET(
      await buildRequest(`/api/jobs/${JOB_A}/markup`, { userId: OPERATOR_ID }),
      routeParams({ id: JOB_A })
    );
    expect(response.status).toBe(200);
  });
});
