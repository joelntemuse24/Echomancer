import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const sdkTrigger = vi.fn();

vi.mock("@trigger.dev/sdk", () => ({
  configure: vi.fn(),
  tasks: {
    trigger: (...args: unknown[]) => sdkTrigger(...args),
  },
}));

describe("triggerTask", () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TRIGGER_SECRET_KEY;
  const originalApi = process.env.TRIGGER_API_URL;

  beforeEach(() => {
    sdkTrigger.mockReset();
    process.env.TRIGGER_SECRET_KEY = "tr_test_secret";
    delete process.env.TRIGGER_API_URL;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TRIGGER_SECRET_KEY;
    else process.env.TRIGGER_SECRET_KEY = originalKey;
    if (originalApi === undefined) delete process.env.TRIGGER_API_URL;
    else process.env.TRIGGER_API_URL = originalApi;
  });

  it("returns the SDK run id when tasks.trigger succeeds", async () => {
    sdkTrigger.mockResolvedValue({ id: "run_sdk" });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { triggerTask } = await import("./trigger-api");
    const handle = await triggerTask("upload.extract", { uploadId: "u1" }, {
      concurrencyKey: "u1",
    });

    expect(handle).toEqual({ id: "run_sdk" });
    expect(sdkTrigger).toHaveBeenCalledWith(
      "upload.extract",
      { uploadId: "u1" },
      { concurrencyKey: "u1" }
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to REST when the SDK returns no run id", async () => {
    sdkTrigger.mockResolvedValue({});
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ id: "run_rest" }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { triggerTask } = await import("./trigger-api");
    const handle = await triggerTask("upload.extract", { uploadId: "u2" }, {
      concurrencyKey: "u2",
    });

    expect(handle).toEqual({ id: "run_rest" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.trigger.dev/api/v1/tasks/upload.extract/trigger");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tr_test_secret"
    );
    expect(JSON.parse(String(init.body))).toEqual({
      payload: { uploadId: "u2" },
      options: { concurrencyKey: "u2" },
    });
  });

  it("retries REST then throws TRIGGER_DISPATCH_FAILED", async () => {
    sdkTrigger.mockRejectedValue(new Error("sdk down"));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "bad key",
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { triggerTask } = await import("./trigger-api");
    await expect(
      triggerTask("upload.extract", { uploadId: "u3" }, { restAttempts: 2 })
    ).rejects.toMatchObject({
      name: "AppError",
      code: "TRIGGER_DISPATCH_FAILED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws TRIGGER_NOT_CONFIGURED when the secret is missing", async () => {
    delete process.env.TRIGGER_SECRET_KEY;
    const { triggerTask } = await import("./trigger-api");
    await expect(triggerTask("upload.extract", { uploadId: "u4" })).rejects.toBeInstanceOf(
      AppError
    );
    await expect(triggerTask("upload.extract", { uploadId: "u4" })).rejects.toMatchObject({
      code: "TRIGGER_NOT_CONFIGURED",
    });
  });
});
