/**
 * Durable Google accounts and anonymous-library merge.
 *
 * Auth.js handles the OAuth dance and CSRF. This module is what actually
 * creates a `users` row (`user_*`, never the Google `sub`) and reassigns the
 * signing-in browser's `anon_*` jobs / uploads / cloned_voices.
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
  created_at: number;
}

export interface GoogleProfileInput {
  googleSub: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
  anonUserId?: string | null;
}

export function isGoogleOAuthConfigured(): boolean {
  return Boolean(
    process.env.AUTH_GOOGLE_ID?.trim() && process.env.AUTH_GOOGLE_SECRET?.trim()
  );
}

export function requireGoogleOAuthConfigured(): {
  id: string;
  secret: string;
} {
  const id = process.env.AUTH_GOOGLE_ID?.trim() ?? "";
  const secret = process.env.AUTH_GOOGLE_SECRET?.trim() ?? "";
  if (!id || !secret) throw new GoogleAuthNotConfiguredError();
  return { id, secret };
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

export async function upsertGoogleUser(input: {
  googleSub: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
}): Promise<UserRow> {
  await ensureTtsJobColumns();
  const googleSub = input.googleSub.trim();
  if (!googleSub) throw new Error("Google account subject is required.");

  const email = input.email?.trim() || null;
  const name = input.name?.trim() || null;
  const image = input.image?.trim() || null;

  const existing = await findUserByGoogleSub(googleSub);
  if (existing) {
    await execute(
      `UPDATE users SET email = ?, name = ?, image = ? WHERE id = ?`,
      [email, name, image, existing.id]
    );
    return { ...existing, email, name, image };
  }

  const id = newDurableUserId();
  try {
    await execute(
      `INSERT INTO users (id, google_sub, email, name, image)
       VALUES (?, ?, ?, ?, ?)`,
      [id, googleSub, email, name, image]
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
}

export async function completeGoogleSignIn(
  input: GoogleProfileInput
): Promise<{ user: UserRow; session: Session }> {
  const googleSub = input.googleSub?.trim() ?? "";
  if (!googleSub) throw new Error("Google account subject is required.");

  const user = await upsertGoogleUser({
    googleSub,
    email: input.email,
    name: input.name,
    image: input.image,
  });

  if (input.anonUserId) {
    await mergeAnonymousOwnership(input.anonUserId, user.id);
  }

  return { user, session: await mintSessionFor(user.id) };
}
