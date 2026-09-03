/**
 * Sign-out issues a brand-new anonymous identity so the next visitor on this
 * browser cannot keep reading the previous `user_*` library.
 */

import { mintSession, type Session } from "@/lib/auth/session";

export async function signOutToAnonymous(): Promise<Session> {
  return mintSession();
}
