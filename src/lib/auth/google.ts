/**
 * Durable Google accounts and anonymous-library merge.
 *
 * Auth.js handles the OAuth dance and CSRF. This module is what actually
 * creates a `users` row (`user_*`, never the Google `sub`) and reassigns the
 * signing-in browser's `anon_*` jobs / uploads / cloned_voices / clone_uploads.
 */

import { AppError } from "@/lib/errors";
import { execute, queryOne } from "@/lib/turso";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import {
  isAnonymousUserId,
  isDurableUserId,
  mintSessionFor,
  newDurableUserId,
  type Session,
} from "@/lib/auth/session";

export class GoogleAuthNotConfiguredError extends AppError {
  constructor() {
    super(
      "GOOGLE_AUTH_NOT_CONFIGURED",
      "Google sign-in is not configured. Set AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET.",
      503
    );
  }
}

export interface UserRow {
  id: string;
  google_sub: string;
  email: string | null;
  name: string | null;
  image: string | null;
  /** 1 when Google reported `email_verified` at sign-in. */
  email_verified: number | null;
  created_at: number;
}

export interface GoogleProfileInput {
  googleSub: string;
  email?: string | null;
  emailVerified?: boolean | null;
  name?: string | null;
  image?: string | null;
  anonUserId?: string | null;
}

export function isGoogleOAuthConfigured(): boolean {
  return Boolean(
    process.env.AUTH_GOOGLE_ID?.trim() && process.env.AUTH_GOOGLE_SECRET?.trim()
  );
}

export async function getUserById(id: string): Promise<UserRow | null> {
  await ensureTtsJobColumns();
  return queryOne<UserRow>(`SELECT * FROM users WHERE id = ? LIMIT 1`, [id]);
}

export async function findUserByGoogleSub(
  googleSub: string
): Promise<UserRow | null> {
  await ensureTtsJobColumns();
  return queryOne<UserRow>(
    `SELECT * FROM users WHERE google_sub = ? LIMIT 1`,
    [googleSub]
  );
}

/**
 * `users.google_sub` is NOT NULL UNIQUE and SQLite cannot relax that on an
 * existing table, so an account created by email link stores this placeholder
 * until the same verified mailbox signs in with Google.
 */
export const EMAIL_SUB_PREFIX = "email:";

export function emailSubFor(email: string): string {
  return `${EMAIL_SUB_PREFIX}${email.trim().toLowerCase()}`;
}

/** Account created by email link whose mailbox has not been seen via Google. */
async function findEmailAccount(email: string): Promise<UserRow | null> {
  return queryOne<UserRow>(
    `SELECT * FROM users
     WHERE google_sub = ? AND email_verified = 1
     LIMIT 1`,
    [emailSubFor(email)]
  );
}

/**
 * The durable account for a verified mailbox: a Google account that reported
 * this address as verified, or an existing email-link account. Created on first
 * use. The caller must already have proven control of the mailbox.
 */
export async function upsertVerifiedEmailUser(rawEmail: string): Promise<UserRow> {
  await ensureTtsJobColumns();
  const email = rawEmail.trim().toLowerCase();
  if (!email) throw new Error("Email address is required.");

  const byGoogle = await queryOne<UserRow>(
    `SELECT * FROM users
     WHERE lower(email) = ? AND email_verified = 1
     ORDER BY created_at ASC
     LIMIT 1`,
    [email]
  );
  if (byGoogle) return byGoogle;

  const id = newDurableUserId();
  const sub = emailSubFor(email);
  try {
    await execute(
      `INSERT INTO users (id, google_sub, email, name, image, email_verified)
       VALUES (?, ?, ?, NULL, NULL, 1)`,
      [id, sub, email]
    );
  } catch (error) {
    const raced = await findUserByGoogleSub(sub);
    if (raced) return raced;
    throw error;
  }
  const created = await getUserById(id);
  if (!created) throw new Error("Failed to read user after insert");
  return created;
}

export async function upsertGoogleUser(input: {
  googleSub: string;
  email?: string | null;
  emailVerified?: boolean | null;
  name?: string | null;
  image?: string | null;
}): Promise<UserRow> {
  await ensureTtsJobColumns();
  const googleSub = input.googleSub.trim();
  if (!googleSub) throw new Error("Google account subject is required.");

  const email = input.email?.trim() || null;
  const name = input.name?.trim() || null;
  const image = input.image?.trim() || null;
  const emailVerified = input.emailVerified === true ? 1 : 0;

  const existing = await findUserByGoogleSub(googleSub);
  if (existing) {
    await execute(
      `UPDATE users SET email = ?, name = ?, image = ?, email_verified = ? WHERE id = ?`,
      [email, name, image, emailVerified, existing.id]
    );
    return { ...existing, email, name, image, email_verified: emailVerified };
  }

  // Someone who signed in by email link first: same verified mailbox, same
  // account. Claim their row for this Google subject instead of splitting them.
  if (emailVerified && email) {
    const emailAccount = await findEmailAccount(email);
    if (emailAccount) {
      await execute(
        `UPDATE users SET google_sub = ?, email = ?, name = ?, image = ?, email_verified = 1 WHERE id = ?`,
        [googleSub, email, name, image, emailAccount.id]
      );
      return {
        ...emailAccount,
        google_sub: googleSub,
        email,
        name,
        image,
        email_verified: 1,
      };
    }
  }

  const id = newDurableUserId();
  try {
    await execute(
      `INSERT INTO users (id, google_sub, email, name, image, email_verified)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, googleSub, email, name, image, emailVerified]
    );
  } catch (error) {
    const raced = await findUserByGoogleSub(googleSub);
    if (raced) return raced;
    throw error;
  }

  const created = await getUserById(id);
  if (!created) throw new Error("Failed to read user after insert");
  return created;
}

/**
 * Reassign rows owned by this browser's anonymous session onto the durable
 * account. Other owners are left untouched.
 */
export async function mergeAnonymousOwnership(
  anonUserId: string,
  durableUserId: string
): Promise<void> {
  if (!isAnonymousUserId(anonUserId) || !isDurableUserId(durableUserId)) {
    return;
  }
  await ensureTtsJobColumns();
  await execute(`UPDATE jobs SET user_id = ? WHERE user_id = ?`, [
    durableUserId,
    anonUserId,
  ]);
  await execute(`UPDATE uploads SET user_id = ? WHERE user_id = ?`, [
    durableUserId,
    anonUserId,
  ]);
  await execute(`UPDATE cloned_voices SET user_id = ? WHERE user_id = ?`, [
    durableUserId,
    anonUserId,
  ]);
  await execute(`UPDATE clone_uploads SET user_id = ? WHERE user_id = ?`, [
    durableUserId,
    anonUserId,
  ]);
}

export async function completeGoogleSignIn(
  input: GoogleProfileInput
): Promise<{ user: UserRow; session: Session }> {
  const googleSub = input.googleSub?.trim() ?? "";
  if (!googleSub) throw new Error("Google account subject is required.");

  const user = await upsertGoogleUser({
    googleSub,
    email: input.email,
    emailVerified: input.emailVerified,
    name: input.name,
    image: input.image,
  });

  if (input.anonUserId) {
    await mergeAnonymousOwnership(input.anonUserId, user.id);
  }

  return { user, session: await mintSessionFor(user.id) };
}
