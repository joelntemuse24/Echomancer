import { beforeEach, describe, expect, it } from "vitest";
import {
  USER_A,
  USER_B,
  UPLOAD_ID_A,
  UPLOAD_ID_B,
  jobRow,
  resetDatabase,
  seedJob,
  seedUpload,
} from "@/test/harness";
import { query, queryOne } from "@/lib/turso";
import { insertClonedVoice } from "@/lib/turso/cloned-voices";
import { newAnonymousUserId } from "@/lib/auth/session";
import {
  completeGoogleSignIn,
  findUserByGoogleSub,
  getUserById,
} from "@/lib/auth/google";

const JOB_A = "aaaaaaaa-0000-4000-8000-0000000000aa";
const JOB_B = "bbbbbbbb-0000-4000-8000-0000000000bb";
const GOOGLE_SUB = "108234567890123456789";

beforeEach(async () => {
  await resetDatabase();
});

describe("completeGoogleSignIn", () => {
  it("creates a durable user_* row and never uses the Google sub as the app id", async () => {
    const { user, session } = await completeGoogleSignIn({
      googleSub: GOOGLE_SUB,
      email: "joel@example.com",
      name: "Joel",
      image: "https://example.com/joel.png",
    });

    expect(user.id).toMatch(/^user_[\w-]{1,64}$/);
    expect(user.id).not.toBe(GOOGLE_SUB);
    expect(user.id.includes(GOOGLE_SUB)).toBe(false);
    expect(user.google_sub).toBe(GOOGLE_SUB);
    expect(user.email).toBe("joel@example.com");
    expect(session.userId).toBe(user.id);
    expect((await findUserByGoogleSub(GOOGLE_SUB))?.id).toBe(user.id);
  });

  it("returns the same user_* for the same Google account", async () => {
    const first = await completeGoogleSignIn({
      googleSub: GOOGLE_SUB,
      email: "joel@example.com",
      name: "Joel",
    });
    const second = await completeGoogleSignIn({
      googleSub: GOOGLE_SUB,
      email: "joel+alias@example.com",
      name: "Joel N",
    });

    expect(second.user.id).toBe(first.user.id);
    expect((await getUserById(first.user.id))?.email).toBe(
      "joel+alias@example.com"
    );
  });

  it("reassigns only the signing-in anon's jobs, uploads and clones", async () => {
    const pdfA = await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: "Joel's book. ".repeat(20),
    });
    const pdfB = await seedUpload({
      id: UPLOAD_ID_B,
      userId: USER_B,
      text: "Someone else. ".repeat(20),
    });
    await seedJob({ id: JOB_A, userId: USER_A, pdfStoragePath: pdfA });
    await seedJob({ id: JOB_B, userId: USER_B, pdfStoragePath: pdfB });
    await insertClonedVoice({
      id: "clone-a",
      userId: USER_A,
      fishVoiceId: "fish-a",
      title: "Joel clone",
      state: "trained",
      model: "s2.1-pro-free",
    });
    await insertClonedVoice({
      id: "clone-b",
      userId: USER_B,
      fishVoiceId: "fish-b",
      title: "Other clone",
      state: "trained",
      model: "s2.1-pro-free",
    });

    const { user } = await completeGoogleSignIn({
      googleSub: GOOGLE_SUB,
      email: "joel@example.com",
      name: "Joel",
      anonUserId: USER_A,
    });

    expect((await jobRow(JOB_A))?.user_id).toBe(user.id);
    expect((await jobRow(JOB_B))?.user_id).toBe(USER_B);

    const uploadA = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM uploads WHERE id = ?`,
      [UPLOAD_ID_A]
    );
    const uploadB = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM uploads WHERE id = ?`,
      [UPLOAD_ID_B]
    );
    expect(uploadA?.user_id).toBe(user.id);
    expect(uploadB?.user_id).toBe(USER_B);

    const clones = await query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM cloned_voices ORDER BY id`
    );
    expect(clones).toEqual([
      { id: "clone-a", user_id: user.id },
      { id: "clone-b", user_id: USER_B },
    ]);
  });

  it("does not merge a foreign or durable id passed as anonUserId", async () => {
    const pdfA = await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: "Stay put. ".repeat(20),
    });
    await seedJob({ id: JOB_A, userId: USER_A, pdfStoragePath: pdfA });

    const first = await completeGoogleSignIn({
      googleSub: GOOGLE_SUB,
      email: "joel@example.com",
      anonUserId: USER_B,
    });
    expect((await jobRow(JOB_A))?.user_id).toBe(USER_A);

    await completeGoogleSignIn({
      googleSub: "999999999999999999999",
      email: "other@example.com",
      anonUserId: first.user.id,
    });
    expect((await jobRow(JOB_A))?.user_id).toBe(USER_A);
  });

  it("rejects an empty Google subject", async () => {
    await expect(
      completeGoogleSignIn({ googleSub: "   ", email: "x@y.z" })
    ).rejects.toThrow(/google/i);
  });
});

describe("anonymous visitors still work", () => {
  it("mints a distinct anon id that is not a users row", async () => {
    const anon = newAnonymousUserId();
    expect(anon).toMatch(/^anon_[0-9a-f]{32}$/);
    expect(await getUserById(anon)).toBeNull();
  });
});
