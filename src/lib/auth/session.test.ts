import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_HEADER,
  attachSessionCookie,
  isSessionConfigured,
  mintSession,
  newAnonymousUserId,
  readOrMintSession,
  readSession,
  signSessionToken,
  verifySessionToken,
} from "./session";

function requestWith(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost/api/jobs", { headers });
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret";
});

describe("session tokens", () => {
  it("round-trips a signed identity", async () => {
    const userId = newAnonymousUserId();
    const token = await signSessionToken(userId);
    expect((await verifySessionToken(token))?.userId).toBe(userId);
  });

  it("rejects a tampered user id", async () => {
    const token = await signSessionToken(newAnonymousUserId());
    const [version, , issuedAt, signature] = token.split(".");
    const forged = [version, newAnonymousUserId(), issuedAt, signature].join(".");
    expect(await verifySessionToken(forged)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signSessionToken(newAnonymousUserId());
    process.env.SESSION_SECRET = "a-different-secret";
    expect(await verifySessionToken(token)).toBeNull();
  });

  it("rejects malformed, empty and wrong-version tokens", async () => {
    expect(await verifySessionToken(undefined)).toBeNull();
    expect(await verifySessionToken("")).toBeNull();
    expect(await verifySessionToken("not-a-token")).toBeNull();
    expect(await verifySessionToken("v0.anon_x.1.sig")).toBeNull();
  });

  it("rejects an id that does not match the expected shape", async () => {
    // Guards against a signed token being reused to smuggle in odd ids.
    const token = await signSessionToken("../../etc/passwd");
    expect(await verifySessionToken(token)).toBeNull();
  });
});

describe("readSession", () => {
  it("reads a valid cookie", async () => {
    const session = await mintSession();
    const found = await readSession(
      requestWith({ cookie: `${SESSION_COOKIE}=${session.token}` })
    );
    expect(found?.userId).toBe(session.userId);
  });

  it("prefers the proxy header when both are present", async () => {
    const fromCookie = await mintSession();
    const fromHeader = await mintSession();
    const found = await readSession(
      requestWith({
        cookie: `${SESSION_COOKIE}=${fromCookie.token}`,
        [SESSION_HEADER]: fromHeader.token,
      })
    );
    expect(found?.userId).toBe(fromHeader.userId);
  });

  it("ignores an unsigned header and falls back to the cookie", async () => {
    // The proxy overwrites this header, but a route the proxy does not match
    // must still refuse to trust client-supplied values.
    const session = await mintSession();
    const found = await readSession(
      requestWith({
        cookie: `${SESSION_COOKIE}=${session.token}`,
        [SESSION_HEADER]: "v1.anon_deadbeef.1.forged",
      })
    );
    expect(found?.userId).toBe(session.userId);
  });

  it("returns null when nothing is present", async () => {
    expect(await readSession(requestWith({}))).toBeNull();
  });
});

describe("readOrMintSession", () => {
  it("reuses an existing session", async () => {
    const existing = await mintSession();
    const result = await readOrMintSession(
      requestWith({ cookie: `${SESSION_COOKIE}=${existing.token}` })
    );
    expect(result.minted).toBe(false);
    expect(result.session.userId).toBe(existing.userId);
  });

  it("mints one for a first-time visitor", async () => {
    const result = await readOrMintSession(requestWith({}));
    expect(result.minted).toBe(true);
    expect(result.session.userId).toMatch(/^anon_[0-9a-f]{32}$/);
  });
});

describe("cookie attributes", () => {
  it("is httpOnly and scoped to the whole site", async () => {
    const response = attachSessionCookie(
      NextResponse.json({ ok: true }),
      await mintSession()
    );
    const cookie = response.cookies.get(SESSION_COOKIE);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(cookie?.path).toBe("/");
  });
});

describe("configuration", () => {
  it("reports configured when a secret is present", () => {
    expect(isSessionConfigured()).toBe(true);
  });

  it("falls back to INTERNAL_JOB_SECRET", async () => {
    delete process.env.SESSION_SECRET;
    process.env.INTERNAL_JOB_SECRET = "shared-secret";
    const token = await signSessionToken(newAnonymousUserId());
    expect(await verifySessionToken(token)).not.toBeNull();
  });
});
