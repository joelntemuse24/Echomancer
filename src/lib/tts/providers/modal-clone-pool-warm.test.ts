/**
 * A voice list or an extract must not start a GPU. The book's synthesize
 * call is the container, and a cover beside it is a spare H100.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execute } from "@/lib/turso";
import { UPLOAD_ID_A, resetDatabase, seedUpload } from "@/test/harness";
import { BATCH_HOST } from "@/lib/tts/providers/modal-endpoints.fixture";
import {
  resetModalCloneWarmForTests,
  setModalCloneWarmSpawnerForTests,
} from "@/lib/tts/providers/modal-clone-warm";
import {
  prewarmClonePoolForUpload,
  prewarmClonePoolForUser,
} from "@/lib/tts/providers/modal-clone-pool-warm";

const USER = "user_" + "c".repeat(32);
const CLONE_ID = "96a74157-aaaa-4bbb-8ccc-ddddeeeeffff";

async function seedTrainedClone(userId: string, state = "trained") {
  await execute(
    `INSERT OR REPLACE INTO cloned_voices
       (id, user_id, fish_voice_id, title, sample_storage_path, state, model)
     VALUES (?, ?, ?, ?, ?, ?, 's2.1-pro-base')`,
    [CLONE_ID, userId, "fish-ref", "Ada", "clones/ada/sample.wav", state]
  );
}

describe("clone pool prewarm", () => {
  const spawned: string[][] = [];

  beforeEach(async () => {
    await resetDatabase();
    spawned.length = 0;
    resetModalCloneWarmForTests();
    setModalCloneWarmSpawnerForTests((command, args) => {
      spawned.push([command, ...args]);
    });
    process.env.MODAL_S2_TTS_URL = BATCH_HOST;
    process.env.MODAL_TOKEN_ID = "test-token";
    delete process.env.CLONE_TTS_PROVIDER;
    delete process.env.MODAL_S2_WARM_HOOK;
  });

  afterEach(() => {
    resetModalCloneWarmForTests();
    delete process.env.MODAL_S2_TTS_URL;
    delete process.env.MODAL_TOKEN_ID;
    delete process.env.CLONE_TTS_PROVIDER;
    delete process.env.MODAL_S2_WARM_HOOK;
  });

  it("does not start a GPU for an account with no trained clone", async () => {
    expect(await prewarmClonePoolForUser(USER, "voice list")).toBe(false);
    expect(await prewarmClonePoolForUser("anon_" + "a".repeat(32), "voice list")).toBe(
      false
    );
    await seedTrainedClone(USER, "training");
    expect(await prewarmClonePoolForUser(USER, "voice list")).toBe(false);
    expect(spawned).toEqual([]);
  });

  it("does not start a GPU for a trained clone on the voice list", async () => {
    await seedTrainedClone(USER);
    expect(await prewarmClonePoolForUser(USER, "voice list")).toBe(false);
    expect(await prewarmClonePoolForUser(USER, "voice list again")).toBe(false);
    expect(spawned).toEqual([]);
  });

  it("stays dark when clones are not rendered on Modal", async () => {
    await seedTrainedClone(USER);
    process.env.CLONE_TTS_PROVIDER = "fish";
    expect(await prewarmClonePoolForUser(USER, "voice list")).toBe(false);
    process.env.MODAL_S2_WARM_HOOK = "0";
    delete process.env.CLONE_TTS_PROVIDER;
    expect(await prewarmClonePoolForUser(USER, "voice list")).toBe(false);
    expect(spawned).toEqual([]);
  });

  it("warms from an upload only when that owner has a trained clone", async () => {
    await seedUpload({
      id: UPLOAD_ID_A,
      userId: "anon_" + "a".repeat(32),
      text: "A short page.",
    });
    expect(await prewarmClonePoolForUpload(UPLOAD_ID_A)).toBe(false);
    expect(spawned).toEqual([]);

    const owned = "22222222-2222-4222-8222-222222222222";
    await seedUpload({ id: owned, userId: USER, text: "A longer page." });
    expect(await prewarmClonePoolForUpload(owned)).toBe(false);

    await seedTrainedClone(USER);
    expect(await prewarmClonePoolForUpload(owned)).toBe(false);
    expect(spawned).toEqual([]);
  });
});
