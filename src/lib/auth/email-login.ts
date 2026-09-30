/**
 * Email sign-in links, sent through Resend.
 *
 * Alongside Google, not instead of it. A link proves control of a mailbox and
 * nothing else, so it lands on the same durable `user_*` a Google account with
 * that verified address would (see `upsertVerifiedEmailUser`). Tokens are
 * random, single use, short lived, and stored only as a SHA-256 hash.
 *
 * The emailed link opens a confirm page; only a same-origin POST consumes the
 * token. Mail scanners that prefetch links therefore cannot burn it, and a
 * foreign site cannot sign a visitor into the attacker's account.
 */

import { AppError } from "@/lib/errors";
import { execute, queryOne } from "@/lib/turso";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import {
  mergeAnonymousOwnership,
  upsertVerifiedEmailUser,
  type UserRow,
} from "@/lib/auth/google";
import {
  isProductionRuntime,
  mintSessionFor,
  type Session,
} from "@/lib/auth/session";

export const EMAIL_LOGIN_TTL_SECONDS = 15 * 60;
const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 10_000;
const MAX_EMAIL_LENGTH = 254;
export const DEFAULT_SIGN_IN_REDIRECT = "/dashboard/queue";

export class EmailLoginNotConfiguredError extends AppError {
  constructor() {
    super(
      "EMAIL_LOGIN_NOT_CONFIGURED",
      "Email sign-in is not configured. Set RESEND_API_KEY and AUTH_EMAIL_FROM.",
      503
    );
  }
}

export class EmailSendError extends AppError {
  constructor() {
    super(
      "EMAIL_SEND_FAILED",
      "We could not send the sign-in email. Try again in a moment.",
      502
    );
  }
}

export function isEmailLoginConfigured(): boolean {
  return Boolean(
    process.env.RESEND_API_KEY?.trim() && process.env.AUTH_EMAIL_FROM?.trim()
  );
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH) return null;
  if (!/^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]+$/.test(email)) {
    return null;
  }
  return email;
}

/** Same-site path only; anything else falls back to the library. */
export function safeNextPath(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_SIGN_IN_REDIRECT;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    return DEFAULT_SIGN_IN_REDIRECT;
  }
  if (/[\u0000-\u001f]/.test(raw)) return DEFAULT_SIGN_IN_REDIRECT;
  return raw;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function newLoginToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Origin used inside the emailed link. The request `Host` is attacker
 * influenced, so production only trusts configured values; a spoofed host would
 * otherwise mail the victim a link that hands the token to another site.
 */
export function loginLinkOrigin(requestOrigin: string): string {
  const configured =
    process.env.AUTH_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim() || "";
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      /* fall through */
    }
  }
  if (isProductionRuntime()) throw new EmailLoginNotConfiguredError();
  return requestOrigin;
}

export function buildLoginUrl(origin: string, token: string, next: string): string {
  const url = new URL("/sign-in/confirm", origin);
  url.searchParams.set("token", token);
  if (next !== DEFAULT_SIGN_IN_REDIRECT) url.searchParams.set("next", next);
  return url.toString();
}

async function sendLoginEmail(to: string, link: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.AUTH_EMAIL_FROM?.trim();
  if (!apiKey || !from) throw new EmailLoginNotConfiguredError();

  const minutes = Math.round(EMAIL_LOGIN_TTL_SECONDS / 60);
  const text = [
    "Sign in to Echomancer",
    "",
    link,
    "",
    `This link works once and expires in ${minutes} minutes. If you did not ask for it, you can ignore this email.`,
  ].join("\n");
  const safeLink = link.replace(/&/g, "&amp;");
  const html = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#111">
<p>Sign in to Echomancer</p>
<p><a href="${safeLink}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;text-decoration:none">Sign in</a></p>
<p style="color:#666;font-size:14px">This link works once and expires in ${minutes} minutes. If you did not ask for it, you can ignore this email.</p>
</div>`;

  let response: Response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: "Sign in to Echomancer",
        text,
        html,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("[email-login] Resend request failed:", error);
    throw new EmailSendError();
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(
      `[email-login] Resend rejected the message (${response.status}): ${detail.slice(0, 300)}`
    );
    throw new EmailSendError();
  }
}

/** Store a fresh token for `email` and mail the link. */
export async function requestEmailLogin(input: {
  email: string;
  next: string;
  requestOrigin: string;
}): Promise<void> {
  if (!isEmailLoginConfigured()) throw new EmailLoginNotConfiguredError();
  const origin = loginLinkOrigin(input.requestOrigin);
  await ensureTtsJobColumns();

  const token = newLoginToken();
  const now = Math.floor(Date.now() / 1000);
  await execute(`DELETE FROM email_login_tokens WHERE expires_at < ?`, [
    now - 24 * 60 * 60,
  ]).catch(() => {});
  await execute(
    `INSERT INTO email_login_tokens (token_hash, email, expires_at) VALUES (?, ?, ?)`,
    [await sha256Hex(token), input.email, now + EMAIL_LOGIN_TTL_SECONDS]
  );

  await sendLoginEmail(input.email, buildLoginUrl(origin, token, input.next));
}

/**
 * Burn the token and return its address, or null when it is unknown, used or
 * expired. The single UPDATE is the whole check, so two concurrent confirms
 * cannot both succeed.
 */
export async function consumeLoginToken(token: unknown): Promise<string | null> {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
  await ensureTtsJobColumns();
  const now = Math.floor(Date.now() / 1000);
  const row = await queryOne<{ email: string }>(
    `UPDATE email_login_tokens SET used_at = ?
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
     RETURNING email`,
    [now, await sha256Hex(token), now]
  );
  return row?.email ?? null;
}

export async function completeEmailSignIn(input: {
  token: unknown;
  anonUserId?: string | null;
}): Promise<{ user: UserRow; session: Session } | null> {
  const email = await consumeLoginToken(input.token);
  if (!email) return null;

  const user = await upsertVerifiedEmailUser(email);
  if (input.anonUserId) {
    await mergeAnonymousOwnership(input.anonUserId, user.id);
  }
  return { user, session: await mintSessionFor(user.id) };
}
