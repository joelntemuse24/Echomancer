import { describe, expect, it } from "vitest";
import { serializeJob } from "@/lib/jobs/serialize";

const timeline = JSON.stringify({
  conn: "conn-test0001",
  windows: [{ start: 0, end: 20, seconds: 4.5 }],
});

describe("serializeJob stream timeline", () => {
  it("exposes the measured stream timeline for stream jobs", () => {
    const job = serializeJob({ id: "j", job_kind: "stream", stream_timeline_json: timeline });
    expect(job.stream_timeline).toEqual({
      conn: "conn-test0001",
      windows: [{ start: 0, end: 20, seconds: 4.5 }],
    });
  });

  it("omits it for take-home jobs and for malformed stored values", () => {
    expect(serializeJob({ id: "j", job_kind: "takehome", stream_timeline_json: timeline }).stream_timeline).toBeNull();
    expect(serializeJob({ id: "j", job_kind: "stream", stream_timeline_json: "{" }).stream_timeline).toBeNull();
    expect(serializeJob({ id: "j", job_kind: "stream" }).stream_timeline).toBeNull();
  });
});
