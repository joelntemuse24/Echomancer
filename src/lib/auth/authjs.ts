/**
 * Auth.js (NextAuth) v5 — Google OAuth broker only.
 *
 * Identity lives in `ec_session`. After a successful Google callback we mint a
 * `user_*` HMAC cookie and expire Auth.js session cookies so the two never
 * fight. CSRF stays with Auth.js (`authjs.csrf-token`).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { NextRequest, NextResponse } from "next/server";
import {
  completeGoogleSignIn,
  GoogleAuthNotConfiguredError,
  isGoogleOAuthConfigured,
} from "@/lib/auth/google";
import { handleApiError } from "@/lib/errors";
import {
  SESSION_COOKIE,
  attachSessionCookie,
  getAuthSecret,
  mintSessionFor,
  stripAuthjsSessionCookies,
  verifySessionToken,
} from "@/lib/auth/session";

type PendingSignIn = { appUserId?: string };

const pendingSignIn = new AsyncLocalStorage<PendingSignIn>();

function googleImage(
  profile: { picture?: unknown; image?: unknown } | undefined
): string | null {
  if (typeof profile?.picture === "string" && profile.picture) {
    return profile.picture;
  }
  if (typeof profile?.image === "string" && profile.image) {
    return profile.image;
  }
  return null;
}

async function readIncomingAnonId(): Promise<string | null> {
  try {
    const { cookies } = await import("next/headers");
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    const session = await verifySessionToken(token);
    return session?.userId ?? null;
  } catch {
    return null;
  }
}

function createNextAuth() {
  const clientId = process.env.AUTH_GOOGLE_ID?.trim() ?? "";
  const clientSecret = process.env.AUTH_GOOGLE_SECRET?.trim() ?? "";

  return NextAuth({
    secret: getAuthSecret(),
    trustHost: true,
    session: { strategy: "jwt", maxAge: 60 },
    providers:
      clientId && clientSecret
        ? [Google({ clientId, clientSecret })]
        : [],
    callbacks: {
      async jwt({ token, account, profile }) {
        if (account?.provider === "google" && account.providerAccountId) {
          const result = await completeGoogleSignIn({
            googleSub: account.providerAccountId,
            email: profile?.email,
            name: profile?.name,
            image: googleImage(profile),
            anonUserId: await readIncomingAnonId(),
          });
          token.appUserId = result.user.id;
          const store = pendingSignIn.getStore();
          if (store) store.appUserId = result.user.id;
        }
        return token;
      },
    },
    pages: {
      error: "/",
    },
  });
}

let cached: ReturnType<typeof createNextAuth> | null = null;

export function getAuthjs() {
  if (!cached) cached = createNextAuth();
  return cached;
}

export function signIn(
  ...args: Parameters<ReturnType<typeof createNextAuth>["signIn"]>
) {
  return getAuthjs().signIn(...args);
}

export function signOut(
  ...args: Parameters<ReturnType<typeof createNextAuth>["signOut"]>
) {
  return getAuthjs().signOut(...args);
}

function isGoogleSignInPath(url: string): boolean {
  try {
    const path = new URL(url).pathname.replace(/\/$/, "");
    return (
      path.endsWith("/api/auth/signin/google") ||
      path.endsWith("/auth/signin/google")
    );
  } catch {
    return false;
  }
}

async function finalizeAuthResponse(res: Response): Promise<NextResponse> {
  const out = new NextResponse(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });

  const appUserId = pendingSignIn.getStore()?.appUserId;
  if (typeof appUserId === "string" && appUserId.startsWith("user_")) {
    attachSessionCookie(out, await mintSessionFor(appUserId));
  }

  stripAuthjsSessionCookies(out);
  return out;
}

export async function handleAuthRequest(
  request: NextRequest,
  method: "GET" | "POST"
): Promise<NextResponse> {
  if (isGoogleSignInPath(request.url) && !isGoogleOAuthConfigured()) {
    return handleApiError(new GoogleAuthNotConfiguredError());
  }

  try {
    return await pendingSignIn.run({}, async () => {
      const handlers = getAuthjs().handlers;
      const res =
        method === "GET"
          ? await handlers.GET(request)
          : await handlers.POST(request);
      return finalizeAuthResponse(res);
    });
  } catch (error) {
    return handleApiError(error);
  }
}
