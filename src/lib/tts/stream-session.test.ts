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

/** `frames` valid MPEG-1 Layer III frames: 128 kbps, 44.1 kHz, 1152 samples each. */
function mp3Frames(frames: number): Buffer {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  frame.fill(0x55, 4);
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}
const FRAME_SECONDS = 1152 / 44100;

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
  it("enforces a small engine ceiling in the actual provider calls", async () => {
    const pdfPath = await seedUpload({ id: UPLOAD_ID_A, userId: USER_A, text: "word ".repeat(200) });
    await seedJob({ id: JOB_ID, userId: USER_A, pdfStoragePath: pdfPath,
      jobKind: "stream", ttsProvider: "openrouter", model: "zonos" });
    const fake = await useProvider(() => ({ audio: fakeMp3(1024), contentType: "audio/mpeg" }));
    const { createStreamAudioIterator } = await import("@/lib/tts/stream-session");
    await drain((await createStreamAudioIterator(JOB_ID)).iterator);
    expect(fake.calls.length).toBeGreaterThan(1);
    expect(fake.calls.every((call) => call.text.length <= 350)).toBe(true);
    expect(fake.calls.map((call) => call.text).join(" ")).toBe("word ".repeat(200).trim());
  });

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

  it("records each window's text range and measured audio length for the read-along clock", async () => {
    await seedStreamJob();
    await useProvider(() => ({ audio: mp3Frames(100), contentType: "audio/mpeg" }));
    const { createStreamAudioIterator } = await import("@/lib/tts/stream-session");
    const { iterator } = await createStreamAudioIterator(JOB_ID, undefined, "conn-abc12345");
    expect(JSON.parse(String((await jobRow(JOB_ID))?.stream_timeline_json)).windows
      .every((w: { seconds: number | null }) => w.seconds === null)).toBe(true);
    await drain(iterator);

    const timeline = JSON.parse(String((await jobRow(JOB_ID))?.stream_timeline_json));
    expect(timeline.conn).toBe("conn-abc12345");
    expect(timeline.windows.length).toBeGreaterThan(1);
    expect(timeline.windows[0].start).toBe(0);
    for (let i = 1; i < timeline.windows.length; i++) {
      expect(timeline.windows[i].start).toBeGreaterThanOrEqual(timeline.windows[i - 1].end);
      expect(BOOK.slice(timeline.windows[i].start, timeline.windows[i].end).trim()).toBe(
        BOOK.slice(timeline.windows[i].start, timeline.windows[i].end)
      );
    }
    for (const window of timeline.windows) {
      expect(window.seconds).toBeCloseTo(100 * FRAME_SECONDS, 3);
    }
  });

  it("times a resumed connection from its own cursor", async () => {
    await seedStreamJob();
    await useProvider(() => ({ audio: mp3Frames(50), contentType: "audio/mpeg" }));
    const { createStreamAudioIterator } = await import("@/lib/tts/stream-session");
    await drain((await createStreamAudioIterator(JOB_ID, undefined, "conn-first01")).iterator);
    const { execute } = await import("@/lib/turso");
    await execute(`UPDATE jobs SET status = 'queued', stream_cursor = 480, stream_chars_used = 480 WHERE id = ?`, [JOB_ID]);
    await drain((await createStreamAudioIterator(JOB_ID, undefined, "conn-second2")).iterator);
    const timeline = JSON.parse(String((await jobRow(JOB_ID))?.stream_timeline_json));
    expect(timeline.conn).toBe("conn-second2");
    expect(timeline.windows[0].start).toBeGreaterThanOrEqual(480);
  });

  it("does not record a length for a window cut short by a hang-up", async () => {
    await seedStreamJob();
    const abort = new AbortController();
    await useProvider(() => {
      abort.abort();
      return { audio: mp3Frames(50), contentType: "audio/mpeg" };
    });
    const { createStreamAudioIterator } = await import("@/lib/tts/stream-session");
    await drain((await createStreamAudioIterator(JOB_ID, abort.signal, "conn-abort01")).iterator);
    const timeline = JSON.parse(String((await jobRow(JOB_ID))?.stream_timeline_json));
    expect(timeline.windows.every((w: { seconds: number | null }) => w.seconds === null)).toBe(true);
  });

  it("speaks a leading copyright line so the cursor stays on the book", async () => {
    const notice = "ISBN 978-0-000-00000-0";
    const book = `${notice}\n\n${"The tide came in slowly. ".repeat(40)}`;
    const pdfPath = await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: book,
    });
    await seedJob({
      id: JOB_ID,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      jobKind: "stream",
    });
    const fake = await useProvider(() => ({
      audio: fakeMp3(1024),
      contentType: "audio/mpeg",
    }));

    const { createStreamAudioIterator } = await import(
      "@/lib/tts/stream-session"
    );
    await drain((await createStreamAudioIterator(JOB_ID)).iterator);

    expect(fake.calls[0]?.text).toMatch(/isbn 978-0-000-00000-0/i);
    const spoken = fake.calls.reduce((sum, call) => sum + call.text.length, 0);
    expect(Number((await jobRow(JOB_ID))?.stream_cursor)).toBe(spoken);
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

  it("applies resolved delivery pauses and title cleanup on Live Stream", async () => {
    const pdfPath = await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: [
        "THE TWO CITIES",
        "Call me Ishmael. Some years ago I thought I would sail about a little and see the watery part of the world.",
        "It is a way I have of driving off the spleen and regulating the circulation.",
      ].join("\n\n"),
    });
    await seedJob({
      id: JOB_ID,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      jobKind: "stream",
      ttsProvider: "edge",
      ttsOptions: { pauseStyle: "sparse", normalizeTitles: true },
    });
    const fake = await useProvider(() => ({
      audio: fakeMp3(1024),
      contentType: "audio/mpeg",
    }));
    fake.id = "edge";

    const { createStreamAudioIterator } = await import(
      "@/lib/tts/stream-session"
    );
    const { iterator } = await createStreamAudioIterator(JOB_ID);
    await drain(iterator);

    expect(fake.calls.length).toBeGreaterThan(0);
    const spoken = fake.calls.map((c) => c.text).join("\n");
    expect(spoken).toMatch(/The Two Cities/i);
    expect(spoken).not.toContain("THE TWO CITIES");
    expect(spoken).toContain("[long-break]");
    expect(spoken).not.toContain("[break]");
    expect(spoken).not.toMatch(/\[conversational seminar tone\]/);
  });

  it("does not prepend the retired seminar cue on Live Stream", async () => {
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
      ttsProvider: "fish",
      ttsOptions: { deliveryPrefix: true },
    });
    const fake = await useProvider(() => ({
      audio: fakeMp3(1024),
      contentType: "audio/mpeg",
    }));
    fake.id = "fish";

    const { createStreamAudioIterator } = await import(
      "@/lib/tts/stream-session"
    );
    const { iterator } = await createStreamAudioIterator(JOB_ID);
    await drain(iterator);

    expect(fake.calls[0]?.text || "").not.toContain(
      "[conversational seminar tone]"
    );
    expect(fake.calls[0]?.text).toMatch(/tide/i);
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
