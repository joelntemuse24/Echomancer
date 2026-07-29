/**
 * Signed session cookies.
 *
 * Echomancer has no login yet, but every job, upload and audio object still
 * needs an owner so one visitor cannot read or delete another visitor's book.
 * A session is therefore an *anonymous but authenticated* identity: the server
 * mints an opaque user id, signs it with `SESSION_SECRET`, and stores it in an
 * httpOnly cookie. Nothing about the identity is client-controlled — a forged
 * cookie fails the HMAC check and is treated as no session at all.
 *
 * When real accounts arrive, `resolveSessionUserId()` becomes the single place
 * that has to learn about them.
 */

import type { NextRequest, NextResponse } from "next/server";

export const SESSION_COOKIE = "ec_session";

/** Proxy hands the verified/minted token to route handlers on this header. */
export const SESSION_HEADER = "x-ec-session";

const TOKEN_VERSION = "v1";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const DEV_FALLBACK_SECRET = "echomancer-dev-session-secret";

export interface Session {
  userId: string;
  issuedAt: number;
  token: string;
}

export class SessionSecretMissingError extends Error {
  constructor() {
    super(
      "SESSION_SECRET (or INTERNAL_JOB_SECRET) must be set so session cookies can be signed."
    );
    this.name = "SessionSecretMissingError";
  }
}

let warnedAboutDevSecret = false;

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
}

/**
 * Signing key. Production must configure one explicitly: generating a random
 * per-instance key would silently hand every serverless instance a different
 * notion of identity, so users would lose their library at random.
 */
export function getSessionSecret(): string {
  const configured =
    process.env.SESSION_SECRET?.trim() ||
    process.env.INTERNAL_JOB_SECRET?.trim() ||
    "";
  if (configured) return configured;

  if (isProductionRuntime()) throw new SessionSecretMissingError();

  if (!warnedAboutDevSecret) {
    warnedAboutDevSecret = true;
    console.warn(
      "[session] SESSION_SECRET is not set — using a well-known development secret. Never do this in production."
    );
  }
  return DEV_FALLBACK_SECRET;
}

export function isSessionConfigured(): boolean {
  try {
    getSessionSecret();
    return true;
  } catch {
    return false;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload)
  );
  return base64UrlEncode(new Uint8Array(signature));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function newAnonymousUserId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `anon_${hex}`;
}

export async function signSessionToken(
  userId: string,
  issuedAt = Math.floor(Date.now() / 1000)
): Promise<string> {
  const payload = `${TOKEN_VERSION}.${userId}.${issuedAt}`;
  return `${payload}.${await hmac(payload, getSessionSecret())}`;
}

export async function verifySessionToken(
  token: string | undefined | null
): Promise<Session | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;

  const [version, userId, issuedAtRaw, signature] = parts as [
    string,
    string,
    string,
    string,
  ];
  if (version !== TOKEN_VERSION) return null;
  if (!/^anon_[0-9a-f]{32}$/.test(userId) && !/^user_[\w-]{1,64}$/.test(userId)) {
    return null;
  }

  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) return null;

  const payload = `${version}.${userId}.${issuedAtRaw}`;
  let expected: string;
  try {
    expected = await hmac(payload, getSessionSecret());
  } catch {
    return null;
  }
  if (!timingSafeEqual(signature, expected)) return null;

  return { userId, issuedAt, token };
}

export async function mintSession(): Promise<Session> {
  const userId = newAnonymousUserId();
  const issuedAt = Math.floor(Date.now() / 1000);
  return { userId, issuedAt, token: await signSessionToken(userId, issuedAt) };
}

/**
 * Read the caller's session. Trusts nothing: header and cookie values are both
 * re-verified against the signing key, so a spoofed {@link SESSION_HEADER} on a
 * path the proxy does not match is still rejected.
 */
export async function readSession(
  request: NextRequest
): Promise<Session | null> {
  const fromHeader = await verifySessionToken(
    request.headers.get(SESSION_HEADER)
  );
  if (fromHeader) return fromHeader;
  return verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
}

/**
 * Session for a request that is allowed to create one (uploads, job create).
 * `minted` tells the caller it must attach the cookie to its response.
 */
export async function readOrMintSession(
  request: NextRequest
): Promise<{ session: Session; minted: boolean }> {
  const existing = await readSession(request);
  if (existing) return { session: existing, minted: false };
  return { session: await mintSession(), minted: true };
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isProductionRuntime(),
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

export function attachSessionCookie<T extends NextResponse>(
  response: T,
  session: Session
): T {
  response.cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions());
  return response;
}
