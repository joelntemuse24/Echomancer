import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranscriptResource, transcriptRevision } from "./transcript-resource";

const document = { blocks: [], sections: [], charCount: 0 };
afterEach(() => vi.unstubAllGlobals());

describe("transcript refresh", () => {
  it("shares in-flight and completed requests, then refreshes on finalization", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => document });
    vi.stubGlobal("fetch", fetcher);
    const resource = createTranscriptResource("book");
    const first = resource.load("processing:1");
    expect(resource.load("processing:1")).toBe(first);
    await first;
    await resource.load("processing:1");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await resource.load("ready:1");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures, so retries can recover", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => document });
    vi.stubGlobal("fetch", fetcher);
    const resource = createTranscriptResource("book");
    await expect(resource.load("revision")).rejects.toThrow("unavailable");
    await expect(resource.load("revision")).resolves.toEqual(document);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("ignores unrelated job changes and notices section progress and finalization", () => {
    const job = { status: "processing", current_section: 1, total_sections: 2,
      duration_seconds: null, segments: [{ index: 0, status: "ready" }] };
    const revision = transcriptRevision(job);
    expect(transcriptRevision({ ...job })).toBe(revision);
    expect(transcriptRevision({ ...job, current_section: 2 })).not.toBe(revision);
    expect(transcriptRevision({ ...job, status: "ready", duration_seconds: 123 })).not.toBe(revision);
  });
});
