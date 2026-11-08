import { describe, expect, it, vi, afterEach } from "vitest";
import { POST } from "./route";
import { USER_A, buildRequest, resetDatabase } from "@/test/harness";

describe("POST /api/capacity/warm", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MODAL_CPU_URL;
    delete process.env.MODAL_CPU_TOKEN;
    delete process.env.WORKER_URL;
    delete process.env.WORKER_SECRET;
  });

  it("rejects a request with no session", async () => {
    const response = await POST(
      await buildRequest("http://localhost/api/capacity/warm", {
        method: "POST",
        body: { reason: "create" },
      })
    );
    expect(response.status).toBe(401);
  });

  it("accepts a session and does not synthesize", async () => {
    await resetDatabase();
    process.env.MODAL_CPU_URL = "https://cpu.example.modal.run";
    process.env.MODAL_CPU_TOKEN = "cpu-token";
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);
    const response = await POST(
      await buildRequest("http://localhost/api/capacity/warm", {
        method: "POST",
        userId: USER_A,
        body: { reason: "create", voiceId: "standard" },
      })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { posted: string[] };
    expect(body.posted).toEqual(["cpu"]);
    const sent = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(sent).toEqual({ warm: true });
    expect(sent.text).toBeUndefined();
  });
});
