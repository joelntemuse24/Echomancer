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

describe("serializeJob ETA", () => {
  const now = () => Math.floor(Date.now() / 1000);

  it("exposes the server estimate for a running take-home job", () => {
    const started = now() - 600;
    const job = serializeJob({
      id: "j",
      job_kind: "takehome",
      status: "processing",
      current_section: 3,
      total_sections: 4,
      first_section_at: started,
      last_section_at: started + 550,
      generation_started_at: started,
      created_at: started,
    });

    expect(job.eta_state).toBe("live");
    expect(job.eta_label).toMatch(/^(under a minute|~\d+ min|~\d+h)/);
    expect(job.eta_label).not.toMatch(/\b0 min\b/);
    expect(job.eta_seconds).toBeGreaterThan(0);
  });

  it("reports finalizing while the last section is being joined", () => {
    const job = serializeJob({
      id: "j",
      job_kind: "takehome",
      status: "processing",
      current_section: 4,
      total_sections: 4,
      generation_started_at: now() - 900,
      created_at: now() - 900,
    });

    expect(job.eta_state).toBe("finalizing");
    expect(job.eta_seconds).toBeGreaterThanOrEqual(15);
    expect(job.eta_label).toBeTruthy();
  });

  it("never applies an assumed fanout of 4 to the heuristic", () => {
    const created = now() - 10;
    const job = serializeJob({
      id: "j",
      job_kind: "takehome",
      status: "queued",
      current_section: 0,
      total_sections: 10,
      created_at: created,
    });

    // 10 sections × 16s + 15s finalize, divided by the fanout of 1.
    expect(job.eta_seconds).toBe(175);
    expect(job.eta_state).toBe("estimating");
    expect(job.eta_label).toBe("Estimating…");
  });

  it("leaves stream jobs without a section ETA", () => {
    const job = serializeJob({ id: "j", job_kind: "stream", status: "processing" });
    expect(job.eta_seconds).toBeNull();
    expect(job.eta_label).toBeNull();
  });
});
