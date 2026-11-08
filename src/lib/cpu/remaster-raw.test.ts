/**
 * Raw remaster planning. No speech provider and no Modal call.
 * Ready objects stay. A missing raw index is listed. Apply is refused
 * until the caller names a mode, and a second apply does not rewrite
 * a ready file.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { USER_A, jobRow, resetDatabase, seedJob, seedUpload, UPLOAD_ID_A } from "@/test/harness";
import { uploadFile, downloadFile } from "@/lib/storage";
import { getCpuTask } from "@/lib/cpu/tasks";
import { applyRawRemaster, planRawRemaster, readyPathFingerprint } from "@/lib/cpu/remaster-raw";
import type { JobSegment } from "@/lib/tts/types";

const JOB_ID = "aaaaaaaa-0000-4000-8000-000000000113";

beforeEach(async () => {
  await resetDatabase();
});

function segments(): JobSegment[] {
  return [
    { index: 0, status: "ready", path: `audiobooks/${JOB_ID}/sections/0000.mp3` },
    { index: 1, status: "ready", path: `audiobooks/${JOB_ID}/sections/0001.mp3` },
    {
      index: 2,
      status: "failed",
      path: "",
      rawPath: `audiobooks/${JOB_ID}/raw/0002.mp3`,
    },
    { index: 3, status: "failed", path: "", rawPath: `audiobooks/${JOB_ID}/raw/0003.mp3` },
  ];
}

describe("planRawRemaster", () => {
  it("keeps ready indexes and lists a raw object that is not there", async () => {
    const present = new Set([`audiobooks/${JOB_ID}/raw/0002.mp3`]);
    const plan = await planRawRemaster({
      segments: segments(),
      total: 4,
      exists: async (path) => present.has(path),
    });
    expect(plan.readyKept).toEqual([0, 1]);
    expect(plan.remaster).toEqual([2]);
    expect(plan.missingRaw).toEqual([3]);
    expect(plan.concatReset).toBe(false);
  });

  it("allows concat only when every index is ready or covered by raw", async () => {
    const plan = await planRawRemaster({
      segments: segments().map((segment) =>
        segment.index === 3 ? { ...segment, status: "ready", path: "audiobooks/x/sections/0003.mp3", rawPath: undefined } : segment
      ),
      total: 4,
      exists: async () => true,
    });
    expect(plan.missingRaw).toEqual([]);
    expect(plan.remaster).toEqual([2]);
    expect(plan.concatReset).toBe(true);
  });
});

describe("applyRawRemaster", () => {
  it("dry-run writes nothing and apply requires an explicit mode", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network"));
    const pdfPath = await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: "Ready section stays. Raw section is mastered later.",
    });
    const readyBytes = Buffer.from("published-ready-bytes");
    await uploadFile(
      `audiobooks/${JOB_ID}/sections`,
      "0000.mp3",
      readyBytes,
      "audio/mpeg"
    );
    await uploadFile(
      `audiobooks/${JOB_ID}/raw`,
      "0001.mp3",
      Buffer.from("raw-take"),
      "audio/mpeg"
    );
    const stored: JobSegment[] = [
      { index: 0, status: "ready", path: `audiobooks/${JOB_ID}/sections/0000.mp3` },
      {
        index: 1,
        status: "failed",
        path: "",
        rawPath: `audiobooks/${JOB_ID}/raw/0001.mp3`,
        error: "cpu lease expired",
      },
    ];
    await seedJob({
      id: JOB_ID,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      status: "failed",
      segments: stored,
      totalSections: 2,
    });
    const fingerprint = readyPathFingerprint(stored);
    const dry = await applyRawRemaster({ jobId: JOB_ID, mode: "dry-run" });
    expect(dry.applied).toBe(false);
    expect(dry.backupPath).toBeNull();
    expect(dry.readyKept).toEqual([0]);
    expect(dry.remaster).toEqual([1]);
    expect(dry.missingRaw).toEqual([]);
    expect(dry.concatReset).toBe(true);
    expect((await jobRow(JOB_ID))?.status).toBe("failed");

    const applied = await applyRawRemaster({ jobId: JOB_ID, mode: "service-available" });
    expect(applied.applied).toBe(true);
    expect(applied.backupPath).toMatch(/repair-backups/);
    const after = await jobRow(JOB_ID);
    expect(after?.status).toBe("queued");
    expect(after?.provider_pin ?? null).toBeNull();
    const next = JSON.parse(String(after?.segments_json)) as JobSegment[];
    expect(next.find((segment) => segment.index === 0)?.path).toBe(stored[0]!.path);
    expect(next.find((segment) => segment.index === 0)?.status).toBe("ready");
    expect(next.find((segment) => segment.index === 1)?.status).toBe("mastering");
    expect(readyPathFingerprint(next.filter((segment) => segment.status === "ready"))).toBe(
      fingerprint
    );
    expect(await downloadFile(stored[0]!.path)).toEqual(readyBytes);
    const master = await getCpuTask(`master:${JOB_ID}:1`);
    expect(master?.status).toBe("queued");
    expect(Number(master?.attempts)).toBe(0);
    expect(master?.input_path).toBe(`audiobooks/${JOB_ID}/raw/0001.mp3`);
    expect(JSON.parse(String(master?.payload_json)).approvedLocal).toBeUndefined();
    const concat = await getCpuTask(`concat:${JOB_ID}`);
    expect(concat?.status).toBe("queued");
    expect(Number(concat?.attempts)).toBe(0);

    const again = await applyRawRemaster({ jobId: JOB_ID, mode: "approve-local" });
    expect(again.applied).toBe(true);
    expect(again.remaster).toEqual([]);
    expect(again.alreadyMastering).toEqual([1]);
    expect(await downloadFile(stored[0]!.path)).toEqual(readyBytes);
    const local = await getCpuTask(`master:${JOB_ID}:1`);
    expect(JSON.parse(String(local?.payload_json)).approvedLocal).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
