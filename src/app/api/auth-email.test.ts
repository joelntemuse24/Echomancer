/**
 * Email sign-in links: request, confirm, single use, origin check, and account
 * linking with Google. Resend is a stubbed `fetch`; nothing leaves the process.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UPLOAD_ID_A,
  USER_A,
  buildRequest,
  jobRow,
  resetDatabase,
  seedJob,
  seedUpload,
} from "@/test/harness";
import { execute, query } from "@/lib/turso";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";
import { completeGoogleSignIn, findUserByGoogleSub } from "@/lib/auth/google";
import {
  consumeLoginToken,
  normalizeEmail,
  safeNextPath,
  sha256Hex,
} from "@/lib/auth/email-login";

const JOB_A = "aaaaaaaa-0000-4000-8000-0000000000e1";
const ORIGIN = "http://localhost:3000";

let sent: { to: string[]; text: string; from: string; auth: string }[] = [];

function stubResend(status = 200) {
  sent = [];
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toBe("https://api.resend.com/emails");
    const body = JSON.parse(String(init?.body));
    sent.push({
      to: body.to,
      text: body.text,
      from: body.from,
      auth: new Headers(init?.headers).get("authorization") ?? "",
    });
    return new Response(status === 200 ? '{"id":"em_1"}' : "nope", { status });
  });
}

function tokenFromLastEmail(): string {
  const match = sent.at(-1)?.text.match(/token=([0-9a-f]{64})/);
  if (!match) throw new Error("no token in the last email");
  return match[1]!;
}

async function requestLink(email: unknown, extra: Record<string, unknown> = {}) {
  const { POST } = await import("@/app/api/auth/email/route");
  return POST(
    await buildRequest("/api/auth/email", {
      method: "POST",
      body: { email, ...extra },
    })
  );
}

async function confirm(
  token: string,
  options: {
    origin?: string | null;
    fetchSite?: string;
    userId?: string;
    next?: string;
  } = {}
) {
  const { POST } = await import("@/app/api/auth/email/verify/route");
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (options.origin !== null) headers.origin = options.origin ?? ORIGIN;
  if (options.fetchSite) headers["sec-fetch-site"] = options.fetchSite;
  const form = new URLSearchParams({ token });
  if (options.next) form.set("next", options.next);
  return POST(
    await buildRequest("/api/auth/email/verify", {
      method: "POST",
      userId: options.userId,
      headers,
      rawBody: form.toString(),
    })
  );
}

function sessionFrom(response: Response): string | undefined {
  for (const raw of response.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    if (pair?.startsWith(`${SESSION_COOKIE}=`)) {
      return pair.slice(SESSION_COOKIE.length + 1);
    }
  }
  return undefined;
}

beforeEach(async () => {
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.AUTH_EMAIL_FROM = "Echomancer <login@echomancer.xyz>";
  await resetDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.RESEND_API_KEY;
  delete process.env.AUTH_EMAIL_FROM;
});

describe("helpers", () => {
  it("normalizes addresses and rejects junk", () => {
    expect(normalizeEmail("  Joel@Example.COM ")).toBe("joel@example.com");
    for (const bad of ["", "nope", "a@b", "a b@c.com", "<x>@y.com", 5, null]) {
      expect(normalizeEmail(bad)).toBeNull();
    }
    expect(normalizeEmail(`${"a".repeat(250)}@x.com`)).toBeNull();
  });

  it("only allows same-site redirect paths", () => {
    expect(safeNextPath("/dashboard/voice")).toBe("/dashboard/voice");
    for (const bad of ["//evil.com", "https://evil.com", "/\\evil.com", "x", undefined]) {
      expect(safeNextPath(bad)).toBe("/dashboard/queue");
    }
  });
});

describe("POST /api/auth/email", () => {
  it("fails closed with 503 when Resend is not configured", async () => {
    delete process.env.RESEND_API_KEY;
    const fetchSpy = stubResend();
    const response = await requestLink("joel@example.com");
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("EMAIL_LOGIN_NOT_CONFIGURED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a bad address and a non-JSON body", async () => {
    stubResend();
    expect((await requestLink("not-an-email")).status).toBe(400);

    const { POST } = await import("@/app/api/auth/email/route");
    const form = await POST(
      await buildRequest("/api/auth/email", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        rawBody: "email=joel@example.com",
      })
    );
    expect(form.status).toBe(415);
    expect(sent).toHaveLength(0);
  });

  it("mails a link through Resend and stores only the token hash", async () => {
    stubResend();
    const response = await requestLink("Joel@Example.com", {
      next: "/dashboard/voice",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(["joel@example.com"]);
    expect(sent[0]!.auth).toBe("Bearer re_test_key");
    expect(sent[0]!.from).toBe("Echomancer <login@echomancer.xyz>");
    expect(sent[0]!.text).toContain(`${ORIGIN}/sign-in/confirm?token=`);
    expect(sent[0]!.text).toContain("next=%2Fdashboard%2Fvoice");

    const token = tokenFromLastEmail();
    const rows = await query<{ token_hash: string; email: string }>(
      `SELECT token_hash, email FROM email_login_tokens`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(await sha256Hex(token));
    expect(rows[0]!.token_hash).not.toBe(token);
    expect(rows[0]!.email).toBe("joel@example.com");
  });

  it("does not follow the request Host into the emailed link", async () => {
    stubResend();
    const { POST } = await import("@/app/api/auth/email/route");
    await POST(
      new (await import("next/server")).NextRequest("http://evil.example/api/auth/email", {
        method: "POST",
        headers: { "content-type": "application/json", host: "evil.example" },
        body: JSON.stringify({ email: "joel@example.com" }),
      })
    );
    expect(sent[0]!.text).toContain(`${ORIGIN}/sign-in/confirm`);
    expect(sent[0]!.text).not.toContain("evil.example");
  });

  it("surfaces a Resend failure as 502 without leaking the provider body", async () => {
    stubResend(500);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await requestLink("joel@example.com");
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.code).toBe("EMAIL_SEND_FAILED");
    expect(JSON.stringify(body)).not.toContain("nope");
  });

  it("limits how many links one address can request", async () => {
    stubResend();
    for (let i = 0; i < 3; i++) {
      expect((await requestLink("joel@example.com")).status).toBe(200);
    }
    const blocked = await requestLink("joel@example.com");
    expect(blocked.status).toBe(429);
    expect(sent).toHaveLength(3);
    expect((await requestLink("other@example.com")).status).toBe(200);
  });
});

describe("POST /api/auth/email/verify", () => {
  it("signs in, moves this browser's library, and burns the token", async () => {
    stubResend();
    const pdfPath = await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: "Chapter one. ".repeat(40),
    });
    await seedJob({ id: JOB_A, userId: USER_A, pdfStoragePath: pdfPath });
    await requestLink("joel@example.com");
    const token = tokenFromLastEmail();

    const response = await confirm(token, {
      userId: USER_A,
      next: "/dashboard/voice",
    });
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location")!).pathname).toBe(
      "/dashboard/voice"
    );

    const session = await verifySessionToken(sessionFrom(response));
    expect(session?.userId).toMatch(/^user_/);
    expect((await jobRow(JOB_A))?.user_id).toBe(session!.userId);

    const user = await query<{ email: string; email_verified: number; google_sub: string }>(
      `SELECT email, email_verified, google_sub FROM users WHERE id = ?`,
      [session!.userId]
    );
    expect(user[0]).toMatchObject({
      email: "joel@example.com",
      email_verified: 1,
      google_sub: "email:joel@example.com",
    });

    const replay = await confirm(token);
    expect(replay.status).toBe(303);
    expect(replay.headers.get("location")).toContain("/sign-in?error=expired");
    expect(sessionFrom(replay)).toBeUndefined();
  });

  it("gives the same address the same account every time", async () => {
    stubResend();
    await requestLink("joel@example.com");
    const first = await verifySessionToken(sessionFrom(await confirm(tokenFromLastEmail())));
    await requestLink("JOEL@example.com");
    const second = await verifySessionToken(sessionFrom(await confirm(tokenFromLastEmail())));
    expect(second?.userId).toBe(first?.userId);
  });

  it("rejects an expired token", async () => {
    stubResend();
    await requestLink("joel@example.com");
    const token = tokenFromLastEmail();
    await execute(`UPDATE email_login_tokens SET expires_at = ?`, [
      Math.floor(Date.now() / 1000) - 1,
    ]);
    const response = await confirm(token);
    expect(response.headers.get("location")).toContain("error=expired");
    expect(sessionFrom(response)).toBeUndefined();
    expect(await consumeLoginToken(token)).toBeNull();
  });

  it("rejects unknown and malformed tokens", async () => {
    for (const token of ["", "abc", "0".repeat(64), "z".repeat(64)]) {
      const response = await confirm(token);
      expect(response.headers.get("location")).toContain("error=expired");
      expect(sessionFrom(response)).toBeUndefined();
    }
  });

  it("refuses a cross-site submit and leaves the token usable", async () => {
    stubResend();
    await requestLink("joel@example.com");
    const token = tokenFromLastEmail();

    for (const origin of ["https://evil.example", null]) {
      const response = await confirm(token, { origin });
      expect(response.headers.get("location")).toContain("error=invalid");
      expect(sessionFrom(response)).toBeUndefined();
    }

    const ok = await confirm(token);
    expect(sessionFrom(ok)).toBeTruthy();
  });

  it("accepts a real browser post that carries Origin: null", async () => {
    stubResend();
    await requestLink("joel@example.com");
    const response = await confirm(tokenFromLastEmail(), {
      origin: "null",
      fetchSite: "same-origin",
    });
    expect(response.headers.get("location")).not.toContain("error=");
    expect(sessionFrom(response)).toBeTruthy();
  });

  it("trusts Sec-Fetch-Site over a matching Origin", async () => {
    stubResend();
    await requestLink("joel@example.com");
    const token = tokenFromLastEmail();
    for (const fetchSite of ["cross-site", "same-site", "none"]) {
      const response = await confirm(token, { fetchSite });
      expect(response.headers.get("location")).toContain("error=invalid");
      expect(sessionFrom(response)).toBeUndefined();
    }
    expect(sessionFrom(await confirm(token))).toBeTruthy();
  });

  it("keeps the confirm page from sending Origin: null", async () => {
    const { metadata } = await import("@/app/sign-in/confirm/page");
    expect(metadata.referrer).toBe("same-origin");
  });

  it("never redirects off-site", async () => {
    stubResend();
    await requestLink("joel@example.com");
    const response = await confirm(tokenFromLastEmail(), {
      next: "//evil.example/steal",
    });
    expect(new URL(response.headers.get("location")!).host).toBe("localhost");
    expect(new URL(response.headers.get("location")!).pathname).toBe(
      "/dashboard/queue"
    );
  });
});

describe("email and Google share one account per verified address", () => {
  it("email sign-in after Google reuses the Google account", async () => {
    stubResend();
    const google = await completeGoogleSignIn({
      googleSub: "118000000000000000777",
      email: "Joel@Example.com",
      emailVerified: true,
      name: "Joel",
    });
    await requestLink("joel@example.com");
    const session = await verifySessionToken(sessionFrom(await confirm(tokenFromLastEmail())));
    expect(session?.userId).toBe(google.user.id);
  });

  it("Google sign-in after email claims the email account instead of splitting it", async () => {
    stubResend();
    await requestLink("joel@example.com");
    const viaEmail = await verifySessionToken(sessionFrom(await confirm(tokenFromLastEmail())));

    const google = await completeGoogleSignIn({
      googleSub: "118000000000000000888",
      email: "joel@example.com",
      emailVerified: true,
      name: "Joel",
    });
    expect(google.user.id).toBe(viaEmail?.userId);
    expect(google.user.google_sub).toBe("118000000000000000888");
    expect((await findUserByGoogleSub("email:joel@example.com"))).toBeNull();
  });

  it("does not merge a Google address Google has not verified", async () => {
    stubResend();
    await requestLink("joel@example.com");
    const viaEmail = await verifySessionToken(sessionFrom(await confirm(tokenFromLastEmail())));

    const google = await completeGoogleSignIn({
      googleSub: "118000000000000000999",
      email: "joel@example.com",
      emailVerified: false,
    });
    expect(google.user.id).not.toBe(viaEmail?.userId);
  });
});
