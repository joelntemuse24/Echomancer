/**
 * Operator-only surfaces (Fish markup).
 *
 * Two gates, both required:
 *   1. Master switch. Production stays off until `ECHO_OPERATOR_TOOLS=1`.
 *      Outside production the switch is on unless set to `0` / `false`.
 *   2. Allowlist. The signed-in Google account must match
 *      `ECHO_OPERATOR_EMAILS` (comma-separated, compared to `users.email`)
 *      or `ECHO_OPERATOR_USER_IDS` (comma-separated `user_*` ids, not the
 *      Google subject). Job ownership does not qualify. An empty allowlist
 *      qualifies nobody.
 */

import { getUserById } from "@/lib/auth/google";
import { isDurableUserId } from "@/lib/auth/session";

export function operatorToolsEnabled(): boolean {
  const flag = process.env.ECHO_OPERATOR_TOOLS?.trim().toLowerCase();
  if (flag === "0" || flag === "false") return false;
  if (flag === "1" || flag === "true") return true;
  return process.env.NODE_ENV !== "production";
}

function splitList(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Google emails allowed to open markup. Compared case-insensitively. */
export function operatorEmailAllowlist(): string[] {
  return splitList(process.env.ECHO_OPERATOR_EMAILS).map((email) =>
    email.toLowerCase()
  );
}

/** Durable `user_*` session ids allowed to open markup. */
export function operatorUserIdAllowlist(): string[] {
  return splitList(process.env.ECHO_OPERATOR_USER_IDS);
}

/**
 * True only for an allowlisted operator while the master switch is on.
 * Lookup failures fail closed so a database blip cannot reveal the page.
 */
export async function isMarkupOperator(
  userId: string | null | undefined
): Promise<boolean> {
  if (!userId || !operatorToolsEnabled()) return false;
  if (operatorUserIdAllowlist().includes(userId)) return true;

  const emails = operatorEmailAllowlist();
  if (!emails.length || !isDurableUserId(userId)) return false;

  try {
    const user = await getUserById(userId);
    const email = user?.email?.trim().toLowerCase() ?? "";
    return email.length > 0 && emails.includes(email);
  } catch {
    return false;
  }
}
