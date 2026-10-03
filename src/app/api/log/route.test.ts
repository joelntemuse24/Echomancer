import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildRequest, resetDatabase } from "@/test/harness";

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDatabase();
});

describe("POST /api/log", () => {
  it("records a pick-time failure on the server log and returns 204", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { POST } = await import("@/app/api/log/route");
    const response = await POST(
      await buildRequest("/api/log", {
        userId: null,
        body: {
          tag: "book-upload",
          message: "Couldn't read that file.",
          detail: "NotReadableError: The file could not be read",
        },
      })
    );
    expect(response.status).toBe(204);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[client:book-upload] Couldn't read that file.")
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("NotReadableError")
    );
  });

  it("swallows unknown tags and bad bodies without erroring", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { POST } = await import("@/app/api/log/route");
    const response = await POST(
      await buildRequest("/api/log", {
        userId: null,
        body: { tag: "not-a-tag", message: "x" },
      })
    );
    expect(response.status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });
});
