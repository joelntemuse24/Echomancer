/**
 * Clone-sample intake: JSON presign, PUT bytes to storage, then create the
 * Fish clone from the stored object — never from a Vercel multipart body.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { maxCloneSampleBytes } from "@/lib/clone-sample-formats";
import { pcmToWav } from "@/lib/tts/pcm-wav";
import { CLONE_SAMPLE_QUALITY_COPY } from "@/lib/tts/clone-sample-quality";
import {
  USER_A,
  USER_B,
  buildRequest,
  fakeMp3,
  resetDatabase,
  routeParams,
} from "@/test/harness";

const SAMPLE = fakeMp3(16 * 1024, 3);

async function mockFishClone() {
  const fish = await import("@/lib/tts/providers/fish");
  return vi.spyOn(fish, "createFishVoiceClone").mockResolvedValue({
    fishVoiceId: "fish-ref-test",
    state: "trained",
    title: "Alex",
  });
}

async function presignSample(
  opts: {
    userId?: string | null;
    fileName?: string;
    contentType?: string;
    byteSize?: number;
  } = {}
) {
  const { POST } = await import("@/app/api/tts/clones/upload/route");
  return POST(
    await buildRequest("/api/tts/clones/upload", {
      userId: opts.userId === undefined ? USER_A : opts.userId,
      body: {
        fileName: opts.fileName ?? "alex.mp3",
        contentType: opts.contentType ?? "audio/mpeg",
        byteSize: opts.byteSize ?? SAMPLE.length,
      },
    })
  );
}

async function putSample(
  uploadId: string,
  putUrl: string,
  putHeaders: Record<string, string>,
  bytes: Buffer,
  userId: string
) {
  const { PUT } = await import(
    "@/app/api/tts/clones/upload/[id]/object/route"
  );
  return PUT(
    await buildRequest(putUrl, {
      method: "PUT",
      userId,
      headers: putHeaders,
      rawBody: bytes,
    }),
    routeParams({ id: uploadId })
  );
}

async function completeClone(
  uploadId: string,
  userId: string | null,
  extra: Record<string, unknown> = {}
) {
  const { POST } = await import("@/app/api/tts/clones/route");
  return POST(
    await buildRequest("/api/tts/clones", {
      userId,
      body: { uploadId, title: "Alex", ...extra },
    })
  );
}

beforeEach(async () => {
  vi.restoreAllMocks();
  process.env.FISH_API_KEY = "test-fish-key";
  await resetDatabase();
});

describe("POST /api/tts/clones/upload (presign)", () => {
  it("returns a PUT target without reading file bytes", async () => {
    const fish = await mockFishClone();
    const response = await presignSample();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.uploadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(body.putUrl).toBe(`/api/tts/clones/upload/${body.uploadId}/object`);
    expect(body.putMethod).toBe("PUT");
    expect(body.putHeaders["Content-Type"]).toBe("audio/mpeg");
    expect(body.sampleStoragePath).toBe(
      `clones/${body.uploadId}/sample.mp3`
    );
    expect(fish).not.toHaveBeenCalled();
  });

  it("rejects multipart so the sample cannot enter the function payload", async () => {
    const { POST } = await import("@/app/api/tts/clones/upload/route");
    const formData = new FormData();
    formData.append(
      "audio",
      new File([SAMPLE], "alex.mp3", { type: "audio/mpeg" }),
      "alex.mp3"
    );
    const response = await POST(
      await buildRequest("/api/tts/clones/upload", {
        method: "POST",
        formData,
        userId: USER_A,
      })
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.code).toBe("USE_PRESIGN");
  });

  it("rejects a declared size over the clone-sample ceiling", async () => {
    const response = await presignSample({
      byteSize: maxCloneSampleBytes() + 1,
    });
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe("FILE_TOO_LARGE");
  });

  it("rejects a non-audio content type", async () => {
    const response = await presignSample({
      fileName: "notes.pdf",
      contentType: "application/pdf",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("INVALID_SAMPLE");
  });

  it("stores the sample under an allowlisted clones/<id>/sample.<ext> key", async () => {
    const response = await presignSample({
      fileName: "a.mp3/../../etc/passwd",
      contentType: "audio/mpeg",
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.sampleStoragePath).toBe(`clones/${body.uploadId}/sample.mp3`);
    expect(body.sampleStoragePath).not.toMatch(/\.\.|\/etc\//);
  });

  it("rejects a missing session", async () => {
    const response = await presignSample({ userId: null });
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("SESSION_REQUIRED");
  });
});

describe("PUT + POST /api/tts/clones (create from stored object)", () => {
  it("creates the clone from storage, not from a request body", async () => {
    const fish = await mockFishClone();
    const presignRes = await presignSample();
    const presign = await presignRes.json();
    expect(presignRes.status).toBe(200);

    const putRes = await putSample(
      presign.uploadId,
      presign.putUrl,
      presign.putHeaders,
      SAMPLE,
      USER_A
    );
    expect(putRes.status).toBe(200);

    const completeRes = await completeClone(presign.uploadId, USER_A);
    const complete = await completeRes.json();
    expect(completeRes.status).toBe(200);
    expect(complete.clone.catalogVoiceId).toBe(`clone:${presign.uploadId}`);
    expect(complete.clone.displayName).toBe("Alex · American");
    expect(complete.clone.locale).toBe("en-US");
    expect(complete.clone.accent).toBe("american");

    expect(fish).toHaveBeenCalledTimes(1);
    const fishArg = fish.mock.calls[0]![0]!;
    expect(fishArg.audio.equals(SAMPLE)).toBe(true);
    expect(fishArg.filename).toMatch(/\.mp3$/);

    const { downloadFile } = await import("@/lib/storage");
    const stored = await downloadFile(presign.sampleStoragePath);
    expect(stored.equals(SAMPLE)).toBe(true);
  });

  it("stores a chosen British accent on the clone card", async () => {
    await mockFishClone();
    const presignRes = await presignSample();
    const presign = await presignRes.json();
    await putSample(
      presign.uploadId,
      presign.putUrl,
      presign.putHeaders,
      SAMPLE,
      USER_A
    );

    const completeRes = await completeClone(presign.uploadId, USER_A, {
      accent: "british",
    });
    const complete = await completeRes.json();
    expect(completeRes.status).toBe(200);
    expect(complete.clone.displayName).toBe("Alex · British");
    expect(complete.clone.locale).toBe("en-GB");
    expect(complete.clone.accentHint).toBe("british");
    expect(complete.clone.accent).toBe("british");
  });

  it("rejects an unknown clone accent", async () => {
    await mockFishClone();
    const presignRes = await presignSample();
    const presign = await presignRes.json();
    const completeRes = await completeClone(presign.uploadId, USER_A, {
      accent: "martian",
    });
    expect(completeRes.status).toBe(400);
    expect((await completeRes.json()).code).toBe("INVALID_BODY");
  });

  it("reports another session's sample as 404, never 403", async () => {
    await mockFishClone();
    const presignRes = await presignSample({ userId: USER_A });
    const presign = await presignRes.json();
    await putSample(
      presign.uploadId,
      presign.putUrl,
      presign.putHeaders,
      SAMPLE,
      USER_A
    );

    const completeRes = await completeClone(presign.uploadId, USER_B);
    expect(completeRes.status).toBe(404);
    expect((await completeRes.json()).code).toBe("NOT_FOUND");
    expect(completeRes.status).not.toBe(403);
  });

  it("rejects complete without a session", async () => {
    await mockFishClone();
    const presignRes = await presignSample();
    const presign = await presignRes.json();
    const response = await completeClone(presign.uploadId, null);
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("SESSION_REQUIRED");
  });

  it("returns the existing clone instead of calling Fish again", async () => {
    const fish = await mockFishClone();
    const presignRes = await presignSample();
    const presign = await presignRes.json();
    await putSample(
      presign.uploadId,
      presign.putUrl,
      presign.putHeaders,
      SAMPLE,
      USER_A
    );
    const first = await completeClone(presign.uploadId, USER_A);
    expect(first.status).toBe(200);
    expect(fish).toHaveBeenCalledTimes(1);

    const second = await completeClone(presign.uploadId, USER_A);
    const body = await second.json();
    expect(second.status).toBe(200);
    expect(body.clone.catalogVoiceId).toBe(`clone:${presign.uploadId}`);
    expect(fish).toHaveBeenCalledTimes(1);
  });

  it("rejects the old multipart fat-body create path", async () => {
    const { POST } = await import("@/app/api/tts/clones/route");
    const formData = new FormData();
    formData.set("title", "Alex");
    formData.append(
      "audio",
      new File([SAMPLE], "alex.mp3", { type: "audio/mpeg" }),
      "alex.mp3"
    );
    const response = await POST(
      await buildRequest("/api/tts/clones", {
        method: "POST",
        formData,
        userId: USER_A,
      })
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.code).toBe("USE_PRESIGN");
  });

  it("rejects a reverberant WAV before calling Fish", async () => {
    const fish = await mockFishClone();
    const wet = syntheticSpeechWav({ wetRt60S: 2.4 });
    const presignRes = await presignSample({
      fileName: "phone.wav",
      contentType: "audio/wav",
      byteSize: wet.length,
    });
    const presign = await presignRes.json();
    await putSample(
      presign.uploadId,
      presign.putUrl,
      presign.putHeaders,
      wet,
      USER_A
    );

    const completeRes = await completeClone(presign.uploadId, USER_A);
    const body = await completeRes.json();
    expect(completeRes.status).toBe(422);
    expect(body.code).toBe("SAMPLE_QUALITY");
    expect(body.verdict).toBe("fail");
    expect(body.ok).toBe(false);
    expect(body.headline).toBe(CLONE_SAMPLE_QUALITY_COPY.failHeadline);
    expect(body.primary_message).toBe(CLONE_SAMPLE_QUALITY_COPY.failPrimary);
    expect(fish).not.toHaveBeenCalled();
  });

  it("allows a dry Wolfe-like WAV through to Fish", async () => {
    const fish = await mockFishClone();
    const dry = syntheticSpeechWav({ wetRt60S: null });
    const presignRes = await presignSample({
      fileName: "wolfe.wav",
      contentType: "audio/wav",
      byteSize: dry.length,
    });
    const presign = await presignRes.json();
    await putSample(
      presign.uploadId,
      presign.putUrl,
      presign.putHeaders,
      dry,
      USER_A
    );

    const completeRes = await completeClone(presign.uploadId, USER_A);
    expect(completeRes.status).toBe(200);
    expect(fish).toHaveBeenCalledTimes(1);
  });
});

const QUALITY_RATE = 16_000;

function syntheticSpeechWav(opts: { wetRt60S: number | null }): Buffer {
  const seconds = 16;
  const burst = 0.22;
  const gap = opts.wetRt60S == null ? 0.18 : Math.min(1.8, Math.max(0.8, opts.wetRt60S));
  const parts: Float32Array[] = [];
  let t = 0;
  let n = 0;
  while (t < seconds) {
    const spoken = tone(burst, 180 + (n % 5) * 40, 0.15);
    parts.push(spoken);
    if (opts.wetRt60S == null) {
      parts.push(new Float32Array(Math.floor(gap * QUALITY_RATE)));
    } else {
      parts.push(decayTail(gap, 180 + (n % 5) * 40, 0.15 * 0.85, opts.wetRt60S));
    }
    t += burst + gap;
    n += 1;
  }
  const nSamples = parts.reduce((sum, p) => sum + p.length, 0);
  const samples = new Float32Array(nSamples);
  let off = 0;
  for (const part of parts) {
    samples.set(part, off);
    off += part.length;
  }
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), i * 2);
  }
  return pcmToWav(pcm, { sampleRate: QUALITY_RATE, numChannels: 1, bitDepth: 16 });
}

function tone(seconds: number, freq: number, amplitude: number): Float32Array {
  const n = Math.floor(seconds * QUALITY_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / QUALITY_RATE);
  }
  return out;
}

function decayTail(
  seconds: number,
  freq: number,
  amplitude: number,
  rt60S: number
): Float32Array {
  const raw = tone(seconds, freq, amplitude);
  const tau = rt60S / Math.log(1000);
  for (let i = 0; i < raw.length; i++) {
    raw[i] = raw[i]! * Math.exp(-i / (tau * QUALITY_RATE));
  }
  return raw;
}
