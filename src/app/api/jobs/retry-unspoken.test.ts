import { beforeEach, describe, expect, it } from "vitest";
import { PATCH } from "@/app/api/jobs/[id]/route";
import {
  USER_A,
  buildRequest,
  jobRow,
  resetDatabase,
  routeParams,
  seedJob,
  seedUpload,
} from "@/test/harness";

const JOB = "3ccf95d7-e4bc-48cb-8710-d435ab2f66fb";

beforeEach(async () => {
  await resetDatabase();
});

describe("retry unspoken sections", () => {
  it("resets failed sections with no audio and leaves ready sections", async () => {
    const pdfPath = await seedUpload({
      id: "upload-retry",
      userId: USER_A,
      text: "The harbor was quiet. ".repeat(40),
    });
    await seedJob({
      id: JOB,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      status: "failed",
      ttsProvider: "drew",
      catalogVoiceId: "drew",
      providerVoiceId: "drew",
      model: "kokoro/drew",
      totalSections: 1785,
      segments: [
        ...Array.from({ length: 599 }, (_, index) => ({
          index,
          path: `audiobooks/${JOB}/sections/${String(index).padStart(4, "0")}.mp3`,
          status: "ready" as const,
        })),
        { index: 599, path: "", status: "failed" as const, attempts: 3, error: "budget" },
        {
          index: 600,
          path: "",
          status: "failed" as const,
          rawPath: `audiobooks/${JOB}/raw/0600.mp3`,
          attempts: 1,
        },
        { index: 601, path: "", status: "failed" as const, attempts: 3 },
      ],
    });

    const response = await PATCH(
      await buildRequest(`/api/jobs/${JOB}`, {
        userId: USER_A,
        method: "PATCH",
        body: { action: "retry" },
      }),
      routeParams({ id: JOB })
    );
    expect(response.status).toBe(200);

    const row = await jobRow(JOB);
    expect(row?.status).toBe("queued");
    expect(row?.next_section_index).toBe(599);
    const segments = JSON.parse(String(row?.segments_json)) as Array<{
      index: number;
      status: string;
      path: string;
      rawPath?: string;
    }>;
    expect(segments).toHaveLength(600);
    expect(segments.some((segment) => segment.index === 599 || segment.index === 601)).toBe(false);
    expect(segments.find((segment) => segment.index === 0)?.status).toBe("ready");
    expect(segments.find((segment) => segment.index === 598)?.path).toContain("0598.mp3");
    expect(segments.find((segment) => segment.index === 600)?.rawPath).toContain("0600.mp3");
  });
});
