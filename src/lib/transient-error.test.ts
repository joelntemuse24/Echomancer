import { describe, expect, it } from "vitest";
import { isTransientWorkerError } from "@/lib/transient-error";

describe("isTransientWorkerError", () => {
  it("treats a Turso HTTP 502 as transient, including when it is wrapped", () => {
    const cause = Object.assign(new Error("Server returned HTTP status 502"), { status: 502 });
    const wrapped = Object.assign(new Error("SERVER: Server returned HTTP status 502"), {
      code: "SERVER_ERROR",
      cause,
    });
    expect(isTransientWorkerError(wrapped)).toBe(true);
    expect(isTransientWorkerError(cause)).toBe(true);
  });

  it("treats a dropped connection and a busy database as transient", () => {
    expect(isTransientWorkerError(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }))).toBe(
      true
    );
    expect(isTransientWorkerError(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }))).toBe(
      true
    );
  });

  it("does not treat a programming error or a client 400 as transient", () => {
    expect(isTransientWorkerError(new TypeError("releaseExpired is not a function"))).toBe(false);
    expect(isTransientWorkerError(new Error("job id missing"))).toBe(false);
    const badRequest = Object.assign(new Error("Server returned HTTP status 400"), { status: 400 });
    expect(isTransientWorkerError(badRequest)).toBe(false);
  });
});
