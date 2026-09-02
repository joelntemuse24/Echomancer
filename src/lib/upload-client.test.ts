import { describe, expect, it } from "vitest";
import {
  NETWORK_UPLOAD_ERROR,
  PAYLOAD_TOO_LARGE_ERROR,
  networkOrParseError,
  readErrorMessage,
} from "@/lib/upload-client";

describe("upload client errors", () => {
  it("surfaces JSON error bodies", async () => {
    const res = new Response(JSON.stringify({ error: "File too large. Maximum size is 512MB." }), {
      status: 413,
      headers: { "content-type": "application/json" },
    });
    expect(await readErrorMessage(res)).toContain("512MB");
  });

  it("does not show Failed to fetch / plaintext 413 as a parse crash", async () => {
    const res = new Response("FUNCTION_PAYLOAD_TOO_LARGE", { status: 413 });
    expect(await readErrorMessage(res)).toBe(PAYLOAD_TOO_LARGE_ERROR);
  });

  it("maps TypeError Failed to fetch to a storage/network message", () => {
    expect(networkOrParseError(new TypeError("Failed to fetch"))).toBe(
      NETWORK_UPLOAD_ERROR
    );
  });
});
