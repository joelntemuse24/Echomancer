/**
 * Operator-only surfaces (Fish markup, and anything else that must stay
 * off the customer UI).
 *
 * On in local/test automatically. Production stays off until
 * `ECHO_OPERATOR_TOOLS=1` (or `true`) is set on the host that serves the
 * route — Vercel for the player link and `GET /api/jobs/[id]/markup`.
 */
export function operatorToolsEnabled(): boolean {
  const flag = process.env.ECHO_OPERATOR_TOOLS?.trim().toLowerCase();
  if (flag === "1" || flag === "true") return true;
  return process.env.NODE_ENV !== "production";
}
