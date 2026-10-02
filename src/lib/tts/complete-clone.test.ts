import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  getFileMetadata: vi.fn(),
}));
const fish = vi.hoisted(() => ({ createFishVoiceClone: vi.fn() }));
const uploads = vi.hoisted(() => ({
  markCloneUploadCompleted: vi.fn(async () => {}),
  markCloneUploadFailed: vi.fn(async () => {}),
}));

vi.mock("@/lib/storage", () => storage);
vi.mock("@/lib/tts/clone-sample-quality-analyze", () => ({ analyzeCloneSampleBuffer: () => null }));
vi.mock("@/lib/tts/clone-sample-audio", () => ({
  cleanupCloneSample: (audio: Buffer, filename: string, contentType: string) => ({ audio, filename, contentType }),
}));
vi.mock("@/lib/tts/providers/fish", () => ({ ...fish, FISH_NATIVE_FREE_MODEL: "s2" }));
vi.mock("@/lib/tts/transcript-qa", () => ({ transcribeCloneReference: async () => ({ text: "" }) }));
vi.mock("@/lib/turso/clone-uploads", () => uploads);
vi.mock("@/lib/turso/cloned-voices", () => ({
  insertClonedVoice: vi.fn(async (row: { id: string }) => ({ id: row.id, state: "trained" })),
}));
vi.mock("@/lib/tts/reference-quality/client", () => ({ requestReferenceCheck: vi.fn(async () => null) }));

import { completeStoredClone } from "@/lib/tts/complete-clone";
import { AppError } from "@/lib/errors";

const ORIGINAL = Buffer.alloc(200_000, 1);
const CLEANED = Buffer.alloc(300_000, 2);

const upload = {
  id: "up1",
  user_id: "user_1",
  sample_storage_path: "clones/up1/sample.wav",
  file_name: "sample.wav",
  content_type: "audio/wav",
  byte_size: ORIGINAL.byteLength,
  status: "pending",
  error_message: null,
  cloned_voice_id: null,
  created_at: 0,
};

const failReport = {
  verdict: "fail" as const,
  headline: "This clip may not clone well.",
  body: "Try a cleaner clip.",
  issues: [{ code: "echo" as const, detail: "echo" }],
  notes: [],
  remaster: true,
  metrics: {} as never,
};

beforeEach(() => {
  vi.clearAllMocks();
  storage.getFileMetadata.mockResolvedValue({ size: ORIGINAL.byteLength });
  storage.downloadFile.mockImplementation(async (p: string) => (p.startsWith("clone-remastered/") ? CLEANED : ORIGINAL));
  fish.createFishVoiceClone.mockResolvedValue({ fishVoiceId: "f1", title: "Me", state: "trained" });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

const base = { userId: "user_1", upload, title: "Me", accent: "irish" as const };

describe("completeStoredClone with the reference gate", () => {
  it("stops a failing clip with 409 SAMPLE_RISKY and keeps the upload usable", async () => {
    const checkReference = vi.fn(async () => ({ report: failReport, remasteredPath: null, ms: 1100 }));
    const err = await completeStoredClone({ ...base, checkReference }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("SAMPLE_RISKY");
    expect(err.statusCode).toBe(409);
    expect(err.details).toMatchObject({ uploadId: "up1", quality: { verdict: "fail" } });
    expect(checkReference).toHaveBeenCalledWith({ uploadId: "up1", samplePath: upload.sample_storage_path, remasterFailing: false });
    expect(fish.createFishVoiceClone).not.toHaveBeenCalled();
    expect(uploads.markCloneUploadFailed).not.toHaveBeenCalled();
  });

  it("clones from the remastered sample after Continue anyway", async () => {
    const checkReference = vi.fn(async () => ({
      report: failReport,
      remasteredPath: "clone-remastered/up1.wav",
      ms: 9000,
    }));
    await completeStoredClone({ ...base, checkReference, acceptQualityRisk: true });
    expect(checkReference).toHaveBeenCalledWith(expect.objectContaining({ remasterFailing: true }));
    const call = fish.createFishVoiceClone.mock.calls[0]![0] as { audio: Buffer; contentType: string };
    expect(call.audio).toBe(CLEANED);
    expect(call.contentType).toBe("audio/wav");
  });

  it("clones the original when the gate passes or is unavailable", async () => {
    await completeStoredClone({ ...base, checkReference: async () => null });
    await completeStoredClone({
      ...base,
      checkReference: async () => ({ report: { ...failReport, verdict: "pass", issues: [] }, remasteredPath: null, ms: 900 }),
    });
    await completeStoredClone({
      ...base,
      checkReference: async () => {
        throw new Error("down");
      },
    });
    expect(fish.createFishVoiceClone).toHaveBeenCalledTimes(3);
    for (const [arg] of fish.createFishVoiceClone.mock.calls) expect((arg as { audio: Buffer }).audio).toBe(ORIGINAL);
  });
});
