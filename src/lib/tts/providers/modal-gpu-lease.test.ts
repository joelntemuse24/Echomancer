import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { execute, query } from "@/lib/turso";
import { resetDatabase } from "@/test/harness";
import { otherCloneShareView } from "@/lib/tts/process-job";
import {
  acquireModalGpuLease,
  decideCloneGpuAdmission,
  modalCloneMaxGpus,
  modalCloneMaxGpusPerUser,
  releaseModalGpuLease,
  type GpuLeaseView,
} from "@/lib/tts/providers/modal-gpu-lease";

const env = {} as NodeJS.ProcessEnv;

async function take(opts: {
  jobId: string;
  userId?: string;
  ownerToken?: string;
  createdAt?: number;
  ttlSeconds?: number;
  globalCap?: number;
  perUserCap?: number;
}) {
  return acquireModalGpuLease({
    jobId: opts.jobId,
    userId: opts.userId ?? "user-a",
    ownerToken: opts.ownerToken ?? `owner-${opts.jobId}`,
    createdAt: opts.createdAt ?? 1,
    ttlSeconds: opts.ttlSeconds ?? 90,
    globalCap: opts.globalCap ?? 20,
    perUserCap: opts.perUserCap ?? 5,
  });
}

describe("clone GPU ceilings", () => {
  it("defaults to 20 GPUs and 5 per user", () => {
    expect(modalCloneMaxGpus(env)).toBe(20);
    expect(modalCloneMaxGpusPerUser(env)).toBe(5);
    expect(modalCloneMaxGpus({ MODAL_S2_MAX_GPUS: "3" } as NodeJS.ProcessEnv)).toBe(3);
    expect(
      modalCloneMaxGpusPerUser({
        MODAL_S2_MAX_GPUS: "20",
        MODAL_S2_MAX_GPUS_PER_USER: "9",
      } as NodeJS.ProcessEnv)
    ).toBe(9);
    expect(modalCloneMaxGpus({ MODAL_S2_MAX_GPUS: "500" } as NodeJS.ProcessEnv)).toBe(64);
  });

  it("gives each book its own GPU until a ceiling, then shares oldest-first", () => {
    const holders: GpuLeaseView[] = [
      { jobId: "h0", userId: "ua", createdAt: 1 },
      { jobId: "h1", userId: "ub", createdAt: 2 },
    ];
    const older: GpuLeaseView = { jobId: "older", userId: "uc", createdAt: 3 };
    const younger: GpuLeaseView = { jobId: "younger", userId: "ud", createdAt: 4 };
    expect(
      decideCloneGpuAdmission({
        jobId: "newer-book",
        userId: "ue",
        createdAt: 5,
        leases: holders.slice(0, 1),
        waiters: [{ jobId: "newer-book", userId: "ue", createdAt: 5 }],
        globalCap: 2,
        perUserCap: 5,
      }).action
    ).toBe("grant");
    expect(
      decideCloneGpuAdmission({
        ...older,
        leases: holders,
        waiters: [older, younger],
        globalCap: 2,
        perUserCap: 5,
      })
    ).toEqual({ action: "share", partnerId: "h0" });
    expect(
      decideCloneGpuAdmission({
        ...younger,
        leases: holders,
        waiters: [older, younger],
        globalCap: 2,
        perUserCap: 5,
      }).action
    ).toBe("queue");
    expect(
      decideCloneGpuAdmission({
        jobId: "h1",
        userId: "ub",
        createdAt: 2,
        leases: holders,
        waiters: [older],
        globalCap: 2,
        perUserCap: 5,
      }).action
    ).toBe("solo");
    expect(
      decideCloneGpuAdmission({
        jobId: "h0",
        userId: "ua",
        createdAt: 1,
        leases: holders,
        waiters: [older],
        globalCap: 2,
        perUserCap: 5,
      })
    ).toEqual({ action: "share", partnerId: "older" });
  });

  it("lets a short book share a warm GPU while the ceiling still has room", () => {
    const holder: GpuLeaseView = { jobId: "long", userId: "ua", createdAt: 1, charCount: 500_000 };
    const article: GpuLeaseView = { jobId: "article", userId: "ub", createdAt: 2, charCount: 3_000 };
    const younger: GpuLeaseView = { jobId: "note", userId: "uc", createdAt: 3, charCount: 4_000 };
    expect(
      decideCloneGpuAdmission({
        ...article,
        leases: [holder],
        waiters: [article, younger],
        globalCap: 20,
        perUserCap: 5,
      })
    ).toEqual({ action: "share", partnerId: "long" });
    expect(
      decideCloneGpuAdmission({
        ...younger,
        leases: [holder],
        waiters: [article, younger],
        globalCap: 20,
        perUserCap: 5,
      }).action
    ).toBe("queue");
    expect(
      decideCloneGpuAdmission({
        ...holder,
        leases: [holder],
        waiters: [article],
        globalCap: 20,
        perUserCap: 5,
      })
    ).toEqual({ action: "share", partnerId: "article" });
    const novel: GpuLeaseView = { jobId: "novel", userId: "ud", createdAt: 4, charCount: 400_000 };
    expect(
      decideCloneGpuAdmission({
        ...novel,
        leases: [holder],
        waiters: [article, novel],
        globalCap: 20,
        perUserCap: 5,
      }).action
    ).toBe("grant");
  });

  it("shares a sixth book of one user with that user's oldest GPU", () => {
    const leases: GpuLeaseView[] = Array.from({ length: 5 }, (_, index) => ({
      jobId: `held-${index}`,
      userId: "same",
      createdAt: index + 1,
    }));
    const sixth: GpuLeaseView = { jobId: "sixth", userId: "same", createdAt: 9 };
    expect(
      decideCloneGpuAdmission({
        ...sixth,
        leases,
        waiters: [sixth],
        globalCap: 20,
        perUserCap: 5,
      })
    ).toEqual({ action: "share", partnerId: "held-0" });
    expect(
      decideCloneGpuAdmission({
        jobId: "other-user",
        userId: "else",
        createdAt: 10,
        leases,
        waiters: [sixth, { jobId: "other-user", userId: "else", createdAt: 10 }],
        globalCap: 20,
        perUserCap: 5,
      }).action
    ).toBe("grant");
  });
});

describe("modal_gpu_leases", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("holds one live row per book and rejects a second owner", async () => {
    expect((await take({ jobId: "book-a", ownerToken: "worker-1" })).ok).toBe(true);
    const second = await take({ jobId: "book-a", ownerToken: "worker-2" });
    expect(second).toEqual({ ok: false, reason: "book" });
    expect((await take({ jobId: "book-a", ownerToken: "worker-1" })).ok).toBe(true);
    const rows = await query<{ job_id: string }>(`SELECT job_id FROM modal_gpu_leases`);
    expect(rows.map((row) => row.job_id)).toEqual(["book-a"]);
  });

  it("stops at the global ceiling and at the per-user ceiling", async () => {
    expect((await take({ jobId: "a", userId: "u1", globalCap: 2 })).ok).toBe(true);
    expect((await take({ jobId: "b", userId: "u2", globalCap: 2 })).ok).toBe(true);
    expect(await take({ jobId: "c", userId: "u3", globalCap: 2 })).toEqual({
      ok: false,
      reason: "global",
    });

    expect((await take({ jobId: "d", userId: "u9", globalCap: 20, perUserCap: 2 })).ok).toBe(true);
    expect((await take({ jobId: "e", userId: "u9", globalCap: 20, perUserCap: 2 })).ok).toBe(true);
    expect(await take({ jobId: "f", userId: "u9", globalCap: 20, perUserCap: 2 })).toEqual({
      ok: false,
      reason: "user",
    });
    expect((await take({ jobId: "g", userId: "u8", globalCap: 20, perUserCap: 2 })).ok).toBe(true);
  });

  it("lets a new book take a lease after the previous owner expires", async () => {
    expect((await take({ jobId: "book-a", ownerToken: "dead" })).ok).toBe(true);
    await execute(
      `UPDATE modal_gpu_leases SET expires_at = unixepoch() - 5 WHERE job_id = ?`,
      ["book-a"]
    );
    expect((await take({ jobId: "book-b", ownerToken: "live" })).ok).toBe(true);
    expect((await take({ jobId: "book-a", ownerToken: "replacement" })).ok).toBe(true);
    const live = await query<{ job_id: string; owner_token: string }>(
      `SELECT job_id, owner_token FROM modal_gpu_leases WHERE expires_at > unixepoch() ORDER BY job_id`
    );
    expect(live).toEqual([
      { job_id: "book-a", owner_token: "replacement" },
      { job_id: "book-b", owner_token: "live" },
    ]);
    expect(await releaseModalGpuLease({ jobId: "book-a", ownerToken: "replacement" })).toBe(true);
    expect((await take({ jobId: "book-c", ownerToken: "next", globalCap: 2 })).ok).toBe(true);
  });

  it("does not invent sections for a share partner with no outline", () => {
    expect(otherCloneShareView(null, [], 24).pending).toEqual([]);
    expect(otherCloneShareView([{ index: 3, text: "Chapter." }], [], 24).pending).toEqual([3]);
  });

  it("routes a second call to a new container and keeps min_containers at 0", () => {
    const source = readFileSync(
      path.join(process.cwd(), "modal/s2_clone_service.py"),
      "utf8"
    );
    expect(source).toContain("@modal.concurrent(max_inputs=1)");
    expect(source).toContain('min_containers=_LIMITS["min_containers"]');
    const contract = readFileSync(path.join(process.cwd(), "modal/s2_contract.py"), "utf8");
    expect(contract).toContain('"min_containers": 0');
  });
});
