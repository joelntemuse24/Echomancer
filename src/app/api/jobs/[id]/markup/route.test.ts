import { beforeEach, describe, expect, it } from "vitest";
import {
  UPLOAD_ID_A,
  USER_A,
  USER_B,
  buildRequest,
  resetDatabase,
  routeParams,
  seedJob,
  seedUpload,
} from "@/test/harness";
import { buildFrozenScript, persistFrozenScript } from "@/lib/tts/frozen-script";
import { narrationScriptForSynthesis } from "@/lib/tts/narration-script";
import { operatorToolsEnabled } from "@/lib/operator/tools";

const JOB_A = "aaaaaaaa-0000-4000-8000-0000000000ab";
const TAGGED = "[whispering] She whispered the marked line by the quay.";

async function seedFrozenFishJob() {
  const pdfPath = await seedUpload({
    id: UPLOAD_ID_A,
    userId: USER_A,
    text: "Chapter one. ".repeat(20),
  });
  await seedJob({
    id: JOB_A,
    userId: USER_A,
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
});

describe("GET /api/jobs/[id]/markup", () => {
  it("returns the exact Fish text for the owner", async () => {
    const { GET } = await import("@/app/api/jobs/[id]/markup/route");
    await seedFrozenFishJob();

    const response = await GET(
      await buildRequest(`/api/jobs/${JOB_A}/markup`, { userId: USER_A }),
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
        { userId: USER_A }
      ),
      routeParams({ id: JOB_A })
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(expected);
  });

  it("hides the job from another session", async () => {
    const { GET } = await import("@/app/api/jobs/[id]/markup/route");
    await seedFrozenFishJob();

    const response = await GET(
      await buildRequest(`/api/jobs/${JOB_A}/markup`, { userId: USER_B }),
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
      userId: USER_A,
      text: "A book that was never claimed.",
    });
    await seedJob({
      id: JOB_A,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      ttsProvider: "fish",
    });

    const response = await GET(
      await buildRequest(`/api/jobs/${JOB_A}/markup`, { userId: USER_A }),
      routeParams({ id: JOB_A })
    );
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("MARKUP_NOT_FROZEN");
  });

  it("stays hidden in production until ECHO_OPERATOR_TOOLS is on", async () => {
    const { GET } = await import("@/app/api/jobs/[id]/markup/route");
    await seedFrozenFishJob();
    const previousNode = process.env.NODE_ENV;
    const previousFlag = process.env.ECHO_OPERATOR_TOOLS;
    process.env.NODE_ENV = "production";
    delete process.env.ECHO_OPERATOR_TOOLS;
    try {
      expect(operatorToolsEnabled()).toBe(false);
      const hidden = await GET(
        await buildRequest(`/api/jobs/${JOB_A}/markup`, { userId: USER_A }),
        routeParams({ id: JOB_A })
      );
      expect(hidden.status).toBe(404);
      expect(await hidden.json()).toEqual({ error: "Job not found" });

      process.env.ECHO_OPERATOR_TOOLS = "1";
      expect(operatorToolsEnabled()).toBe(true);
      const open = await GET(
        await buildRequest(`/api/jobs/${JOB_A}/markup`, { userId: USER_A }),
        routeParams({ id: JOB_A })
      );
      expect(open.status).toBe(200);
    } finally {
      process.env.NODE_ENV = previousNode;
      if (previousFlag === undefined) delete process.env.ECHO_OPERATOR_TOOLS;
      else process.env.ECHO_OPERATOR_TOOLS = previousFlag;
    }
  });
});
