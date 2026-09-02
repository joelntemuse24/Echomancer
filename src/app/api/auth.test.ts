/**
 * Google OAuth routes: CSRF, account linking through the handler wrapper,
 * ownership after merge, and sign-out reminting a fresh anonymous cookie.
 *
 * Google itself is never contacted — the provider exchange is mocked, and
 * account linking is the app's `completeGoogleSignIn` path.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  UPLOAD_ID_A,
  USER_A,
  USER_B,
  buildRequest,
  jobRow,
  resetDatabase,
  routeParams,
  seedJob,
  seedUpload,
  sessionCookieFor,
} from "@/test/harness";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";
import { completeGoogleSignIn } from "@/lib/auth/google";
import { signOutToAnonymous } from "@/lib/auth/sign-out";

const JOB_A = "aaaaaaaa-0000-4000-8000-0000000000c1";
const GOOGLE_SUB = "118000000000000000001";

function cookieMap(response: Response): Map<string, string> {
  const map = new Map<string, string>();
  const header = response.headers.get("set-cookie");
  const cookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : header
        ? [header]
        : [];
  for (const raw of cookies) {
    const [pair] = raw.split(";");
    const eq = pair?.indexOf("=") ?? -1;
    if (eq < 0 || !pair) continue;
    map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return map;
}

beforeEach(async () => {
  await resetDatabase();
});

describe("Auth.js CSRF", () => {
  it("issues a csrf token", async () => {
    const { GET } = await import("@/app/api/auth/[...nextauth]/route");
    const response = await GET(
      new NextRequest("http://localhost/api/auth/csrf")
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { csrfToken?: string };
    expect(body.csrfToken).toMatch(/^[0-9a-f]+$/i);
  });

  it("rejects a Google sign-in POST without a csrf token", async () => {
    const { POST } = await import("@/app/api/auth/[...nextauth]/route");
    const response = await POST(
      new NextRequest("http://localhost/api/auth/signin/google", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "callbackUrl=%2Fdashboard%2Fqueue",
      })
    );
    // Auth.js redirects to an error page (302) rather than returning 4xx.
    expect(response.status).not.toBe(200);
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(cookieMap(response).has(SESSION_COOKIE)).toBe(false);
  });

  it("rejects the Google callback without a state / csrf cookie", async () => {
    const { GET } = await import("@/app/api/auth/[...nextauth]/route");
    const response = await GET(
      new NextRequest(
        "http://localhost/api/auth/callback/google?code=forged&state=forged"
      )
    );

    expect(response.status).not.toBe(200);
    const session = await verifySessionToken(cookieMap(response).get(SESSION_COOKIE));
    expect(session?.userId.startsWith("user_")).toBeFalsy();
  });
});

describe("Google account linking and ownership", () => {
  it("lets the signed-in user see merged jobs and 404s everyone else", async () => {
    const pdfPath = await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: "Chapter one. ".repeat(40),
    });
    await seedJob({
      id: JOB_A,
      userId: USER_A,
      pdfStoragePath: pdfPath,
    });

    const { session } = await completeGoogleSignIn({
      googleSub: GOOGLE_SUB,
      email: "joel@example.com",
      name: "Joel",
      anonUserId: USER_A,
    });

    const { GET } = await import("@/app/api/jobs/[id]/route");
    const mine = await GET(
      await buildRequest(`/api/jobs/${JOB_A}`, { userId: session.userId }),
      routeParams({ id: JOB_A })
    );
    expect(mine.status).toBe(200);
    expect((await mine.json()).job.id).toBe(JOB_A);

    const theirs = await GET(
      await buildRequest(`/api/jobs/${JOB_A}`, { userId: USER_B }),
      routeParams({ id: JOB_A })
    );
    expect(theirs.status).toBe(404);

    const staleAnon = await GET(
      await buildRequest(`/api/jobs/${JOB_A}`, { userId: USER_A }),
      routeParams({ id: JOB_A })
    );
    expect(staleAnon.status).toBe(404);
    expect((await jobRow(JOB_A))?.user_id).toBe(session.userId);
  });
});

describe("sign-out", () => {
  it("clears the durable identity and issues a fresh anonymous cookie", async () => {
    const { session: signedIn } = await completeGoogleSignIn({
      googleSub: GOOGLE_SUB,
      email: "joel@example.com",
      anonUserId: USER_A,
    });
    const next = await signOutToAnonymous();
    expect(next.userId).toMatch(/^anon_[0-9a-f]{32}$/);
    expect(next.userId).not.toBe(signedIn.userId);
    expect(next.userId).not.toBe(USER_A);
  });

  it("POST /api/auth/logout does not keep the previous user_id", async () => {
    const { session: signedIn } = await completeGoogleSignIn({
      googleSub: GOOGLE_SUB,
      email: "joel@example.com",
      anonUserId: USER_A,
    });

    const { POST } = await import("@/app/api/auth/logout/route");
    const response = await POST(
      await buildRequest("/api/auth/logout", {
        userId: signedIn.userId,
        method: "POST",
      })
    );

    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(400);
    const token = cookieMap(response).get(SESSION_COOKIE);
    expect(token).toBeTruthy();
    const session = await verifySessionToken(token);
    expect(session?.userId).toMatch(/^anon_[0-9a-f]{32}$/);
    expect(session?.userId).not.toBe(signedIn.userId);

    const pdfPath = await seedUpload({
      id: UPLOAD_ID_A,
      userId: signedIn.userId,
      text: "Library. ".repeat(20),
    });
    await seedJob({
      id: JOB_A,
      userId: signedIn.userId,
      pdfStoragePath: pdfPath,
    });

    const { GET } = await import("@/app/api/jobs/[id]/route");
    const after = await GET(
      await buildRequest(`/api/jobs/${JOB_A}`, {
        cookie: await sessionCookieFor(session!.userId),
      }),
      routeParams({ id: JOB_A })
    );
    expect(after.status).toBe(404);
  });
});

describe("Google env fail-closed", () => {
  it("refuses to start Google sign-in when credentials are missing in production", async () => {
    const previous = {
      id: process.env.AUTH_GOOGLE_ID,
      secret: process.env.AUTH_GOOGLE_SECRET,
      vercel: process.env.VERCEL,
    };
    delete process.env.AUTH_GOOGLE_ID;
    delete process.env.AUTH_GOOGLE_SECRET;
    process.env.VERCEL = "1";
    try {
      const { POST } = await import("@/app/api/auth/[...nextauth]/route");
      const response = await POST(
        new NextRequest("http://localhost/api/auth/signin/google", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "csrfToken=not-checked-when-unconfigured",
        })
      );
      expect(response.status).toBe(503);
      const body = (await response.json()) as { code?: string; error?: string };
      expect(body.code).toBe("GOOGLE_AUTH_NOT_CONFIGURED");
      expect(body.error).toMatch(/Google/i);
    } finally {
      if (previous.id) process.env.AUTH_GOOGLE_ID = previous.id;
      else delete process.env.AUTH_GOOGLE_ID;
      if (previous.secret) process.env.AUTH_GOOGLE_SECRET = previous.secret;
      else delete process.env.AUTH_GOOGLE_SECRET;
      if (previous.vercel) process.env.VERCEL = previous.vercel;
      else delete process.env.VERCEL;
    }
  });
});
