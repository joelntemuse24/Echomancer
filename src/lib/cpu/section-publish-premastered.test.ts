import { afterEach, describe, expect, it } from "vitest";
import { fileExists } from "@/lib/storage";
import { getCpuTask } from "@/lib/cpu/tasks";
import { commitSectionAudio } from "@/lib/cpu/section-publish";
import { resetDatabase } from "@/test/harness";

function toneWav(): Buffer {
  const sampleRate = 16_000;
  const samples = Math.floor(sampleRate * 0.4);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.2;
    data.writeInt16LE(Math.max(-32767, Math.min(32767, value * 32767)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** A buffer the silence check accepts as an MP3 (frame sync, long enough). */
function fakeMp3(): Buffer {
  const body = Buffer.alloc(900, 7);
  body[0] = 0xff;
  body[1] = 0xfb;
  return body;
}

describe("premastered Kokoro sections", () => {
  afterEach(async () => {
    delete process.env.TTS_SECTION_MASTER;
    delete process.env.WORKER;
    await resetDatabase();
  });

  it("publishes the container MP3 and does not enqueue a CPU master", async () => {
    process.env.TTS_SECTION_MASTER = "1";
    process.env.WORKER = "1";
    const mp3 = fakeMp3();
    const committed = await commitSectionAudio({
      jobId: "job-premastered",
      index: 3,
      audio: toneWav(),
      extension: "wav",
      contentType: "audio/wav",
      chain: "podcast",
      qaDeferred: false,
      premastered: mp3,
    });
    expect(committed.ready).toBe(true);
    expect(committed.mastered).toBe(true);
    expect(committed.contentType).toBe("audio/mpeg");
    expect(committed.path).toBe("audiobooks/job-premastered/sections/0003.mp3");
    expect(committed.rawPath).toBe("audiobooks/job-premastered/raw/0003.wav");
    expect(await fileExists(committed.path)).toBe(true);
    expect(await fileExists(committed.rawPath!)).toBe(true);
    expect(await getCpuTask("master:job-premastered:3")).toBeNull();
  });

  it("keeps the CPU master when the premastered bytes are silent", async () => {
    process.env.TTS_SECTION_MASTER = "1";
    process.env.WORKER = "1";
    const committed = await commitSectionAudio({
      jobId: "job-silent-master",
      index: 0,
      audio: toneWav(),
      extension: "wav",
      contentType: "audio/wav",
      chain: "podcast",
      qaDeferred: false,
      premastered: Buffer.alloc(32),
    });
    expect(committed.ready).toBe(false);
    expect(await getCpuTask("master:job-silent-master:0")).not.toBeNull();
    expect(await fileExists("audiobooks/job-silent-master/sections/0000.mp3")).toBe(false);
  });
});
