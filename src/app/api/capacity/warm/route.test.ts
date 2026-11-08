import { describe, expect, it, vi, afterEach } from "vitest";
import { POST } from "./route";
import { queryOne } from "@/lib/turso";
import { SESSION_HEADER, signSessionToken } from "@/lib/auth/session";
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

  it("does not claim or call out when the only session is the proxy header", async () => {
    await resetDatabase();
    process.env.MODAL_CPU_URL = "https://cpu.example.modal.run";
    process.env.MODAL_CPU_TOKEN = "cpu-token";
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);
    const token = await signSessionToken(USER_A);
    const response = await POST(
      await buildRequest("http://localhost/api/capacity/warm", {
        method: "POST",
        headers: { [SESSION_HEADER]: token },
        body: { reason: "create", voiceId: "sowell" },
      })
    );
    expect(response.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
    const row = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM capacity_warms`
    );
    expect(Number(row?.n)).toBe(0);
  });

  it("accepts a guest cookie and does not synthesize", async () => {
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
