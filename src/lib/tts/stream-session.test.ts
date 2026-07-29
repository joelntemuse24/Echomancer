/**
 * Live listen cursor discipline.
 *
 * The cursor is the only record of how far into the book a session has read, and
 * the character budget is what caps the cost of a free sample. Advancing either
 * one for a window that produced no audible audio would silently skip that
 * passage forever *and* charge the user's listening allowance for silence.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  UPLOAD_ID_A,
  USER_A,
  createFakeProvider,
  emptyWav,
  fakeMp3,
  jobRow,
  resetDatabase,
  seedJob,
  seedUpload,
} from "@/test/harness";

const JOB_ID = "dddddddd-0000-4000-8000-000000000001";
const BOOK = "The tide came in slowly. ".repeat(80);

async function seedStreamJob() {
  const pdfPath = await seedUpload({
    id: UPLOAD_ID_A,
    userId: USER_A,
    text: BOOK,
  });
  await seedJob({
    id: JOB_ID,
    userId: USER_A,
    pdfStoragePath: pdfPath,
    jobKind: "stream",
  });
}

async function useProvider(
  respond?: Parameters<typeof createFakeProvider>[0]
) {
  const providers = await import("@/lib/tts/providers");
  const fake = createFakeProvider(respond);
  vi.spyOn(providers, "resolveStockAdapter").mockReturnValue(fake);
  return fake;
}

async function drain(iterator: AsyncGenerator<Uint8Array, void, unknown>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterator) chunks.push(chunk);
  return chunks;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDatabase();
});

describe("createStreamAudioIterator", () => {
  it("advances the cursor and budget as audible windows are delivered", async () => {
    await seedStreamJob();
    await useProvider(() => ({
      audio: fakeMp3(1024),
      contentType: "audio/mpeg",
    }));

    const { createStreamAudioIterator } = await import(
      "@/lib/tts/stream-session"
    );
    const { contentType, iterator } = await createStreamAudioIterator(JOB_ID);
    expect(contentType).toBe("audio/mpeg");

    const chunks = await drain(iterator);
    expect(chunks.length).toBeGreaterThan(0);

    const row = await jobRow(JOB_ID);
    expect(Number(row?.stream_cursor)).toBeGreaterThan(0);
    expect(Number(row?.stream_chars_used)).toBeGreaterThan(0);
  });

  it("does not advance the cursor when the narrator returns silence", async () => {
    await seedStreamJob();
    await useProvider(() => ({ audio: emptyWav(), contentType: "audio/wav" }));

    const { createStreamAudioIterator } = await import(
      "@/lib/tts/stream-session"
    );
    const { iterator } = await createStreamAudioIterator(JOB_ID);

    await expect(drain(iterator)).rejects.toThrow(/no audio/i);

    const row = await jobRow(JOB_ID);
    expect(Number(row?.stream_cursor)).toBe(0);
    expect(Number(row?.stream_chars_used)).toBe(0);
    expect(row?.status).toBe("failed");
  });

  it("retries a silent window once before giving up", async () => {
    await seedStreamJob();
    const fake = await useProvider((_input, index) =>
      index === 0
        ? { audio: emptyWav(), contentType: "audio/wav" }
        : { audio: fakeMp3(1024), contentType: "audio/mpeg" }
    );

    const { createStreamAudioIterator } = await import(
      "@/lib/tts/stream-session"
    );
    const { iterator } = await createStreamAudioIterator(JOB_ID);
    await drain(iterator);

    // Two calls for the first window: the silent attempt and the retry.
    expect(fake.calls.length).toBeGreaterThan(1);
    expect(Number((await jobRow(JOB_ID))?.stream_cursor)).toBeGreaterThan(0);
  });

  it("refuses a second concurrent reader of the same session", async () => {
    await seedStreamJob();
    await useProvider();

    const { createStreamAudioIterator } = await import(
      "@/lib/tts/stream-session"
    );
    await createStreamAudioIterator(JOB_ID);

    await expect(createStreamAudioIterator(JOB_ID)).rejects.toThrow(
      /streamable state/i
    );
  });

  it("refuses to reopen a failed session", async () => {
    await seedStreamJob();
    const { execute } = await import("@/lib/turso");
    await execute(`UPDATE jobs SET status = 'failed' WHERE id = ?`, [JOB_ID]);

    const { createStreamAudioIterator } = await import(
      "@/lib/tts/stream-session"
    );
    await expect(createStreamAudioIterator(JOB_ID)).rejects.toThrow(
      /cannot be reopened/i
    );
  });

  it("refuses a take-home job", async () => {
    const pdfPath = await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: BOOK,
    });
    await seedJob({
      id: JOB_ID,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      jobKind: "takehome",
    });

    const { createStreamAudioIterator } = await import(
      "@/lib/tts/stream-session"
    );
    await expect(createStreamAudioIterator(JOB_ID)).rejects.toThrow(
      /Not a stream session/i
    );
  });

  it("refuses once the listening budget is spent", async () => {
    await seedStreamJob();
    const { execute } = await import("@/lib/turso");
    await execute(
      `UPDATE jobs SET stream_chars_used = stream_max_chars WHERE id = ?`,
      [JOB_ID]
    );

    const { createStreamAudioIterator } = await import(
      "@/lib/tts/stream-session"
    );
    await expect(createStreamAudioIterator(JOB_ID)).rejects.toThrow(
      /budget exhausted/i
    );
  });
});
