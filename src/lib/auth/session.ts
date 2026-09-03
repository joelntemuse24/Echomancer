/**
 * Signed session cookies.
 *
 * Every job, upload and audio object needs an owner. Visitors start with an
 * anonymous identity (`anon_<32 hex>`). Google sign-in upgrades the same
 * httpOnly cookie to a durable `user_*` id — never the Google subject.
 * Nothing about the identity is client-controlled: a forged cookie fails the
 * HMAC check and is treated as no session at all.
 *
 * {@link resolveSessionUserId} is the single function routes use to read the
 * caller. Trigger jobs keep using `jobs.user_id`, which is that same id after
 * a merge.
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

export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
}

export class AuthSecretMissingError extends Error {
  constructor() {
    super(
      "AUTH_SECRET or SESSION_SECRET (or INTERNAL_JOB_SECRET) must be set so Google sign-in can be signed."
    );
    this.name = "AuthSecretMissingError";
  }
}

/**
 * Auth.js signing key. Reuses `SESSION_SECRET` when `AUTH_SECRET` is unset so
 * we do not mint a second, divergent secret.
 */
export function getAuthSecret(): string {
  const configured =
    process.env.AUTH_SECRET?.trim() ||
    process.env.SESSION_SECRET?.trim() ||
    process.env.INTERNAL_JOB_SECRET?.trim() ||
    "";
  if (configured) return configured;
  if (isProductionRuntime()) throw new AuthSecretMissingError();
  if (!warnedAboutDevSecret) {
    warnedAboutDevSecret = true;
    console.warn(
      "[session] AUTH_SECRET/SESSION_SECRET is not set — using a well-known development secret. Never do this in production."
    );
  }
  return DEV_FALLBACK_SECRET;
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

function randomHexId(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function isAnonymousUserId(userId: string): boolean {
  return /^anon_[0-9a-f]{32}$/.test(userId);
}

export function isDurableUserId(userId: string): boolean {
  return /^user_[\w-]{1,64}$/.test(userId);
}

export function newAnonymousUserId(): string {
  return `anon_${randomHexId(16)}`;
}

/** App-owned durable id. Never a Google `sub`. */
export function newDurableUserId(): string {
  return `user_${randomHexId(16)}`;
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

export async function mintSessionFor(userId: string): Promise<Session> {
  if (!isAnonymousUserId(userId) && !isDurableUserId(userId)) {
    throw new Error("Refusing to mint a session for an invalid user id.");
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  return { userId, issuedAt, token: await signSessionToken(userId, issuedAt) };
}

export async function mintSession(): Promise<Session> {
  return mintSessionFor(newAnonymousUserId());
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
/**
 * The only identity resolver for HTTP routes. Header and cookie are both
 * re-verified; the returned id is either `anon_*` or `user_*`.
 */
export async function resolveSessionUserId(
  request: NextRequest
): Promise<string | null> {
  const session = await readSession(request);
  return session?.userId ?? null;
}

export async function readOrMintSession(
  request: NextRequest
): Promise<{ session: Session; minted: boolean }> {
  const existing = await readSession(request);
  const userId = existing ? await resolveSessionUserId(request) : null;
  if (existing && userId) {
    return { session: { ...existing, userId }, minted: false };
  }
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

/** Auth.js identity cookies — never the source of ownership. */
export const AUTHJS_SESSION_COOKIE_NAMES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "authjs.callback-url",
  "__Secure-authjs.callback-url",
] as const;

/**
 * Expire Auth.js session cookies so they cannot diverge from `ec_session`.
 * CSRF cookies are left alone — they are not an identity.
 */
export function stripAuthjsSessionCookies<T extends NextResponse>(response: T): T {
  for (const name of AUTHJS_SESSION_COOKIE_NAMES) {
    response.cookies.set(name, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: name.startsWith("__Secure-") || isProductionRuntime(),
      path: "/",
      maxAge: 0,
    });
  }
  return response;
}
