/**
 * A non-HttpOnly hint of signed-in vs signed-out. No name, email, or id.
 *
 * The session cookie is HttpOnly, so the header cannot know which control
 * to draw until `/api/viewer` returns. This cookie is set by the proxy from
 * the already-verified session and is readable on the first paint.
 */

export const AUTH_HINT_COOKIE = "ec_signed_in";

export type AuthHint = "in" | "out" | "unknown";

/** Runs before first paint. Values are only `in` or `out`. */
export const AUTH_HINT_BOOT =
  "(function(){try{var p=document.cookie.split('; ');for(var i=0;i<p.length;i++){if(p[i].indexOf('ec_signed_in=')===0){var v=p[i].slice(13);if(v==='1')document.documentElement.dataset.auth='in';else if(v==='0')document.documentElement.dataset.auth='out';break;}}}catch(e){}})();";

export function authHintFromValue(value: string | undefined | null): AuthHint {
  if (value === "1") return "in";
  if (value === "0") return "out";
  return "unknown";
}

export function parseAuthHintCookie(header: string | undefined | null): AuthHint {
  if (!header) return "unknown";
  const parts = header.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${AUTH_HINT_COOKIE}=`)) continue;
    return authHintFromValue(trimmed.slice(AUTH_HINT_COOKIE.length + 1));
  }
  return "unknown";
}

/**
 * The home intro is the signed-out line. A known signed-in visitor never
 * sees it. Unknown stays hidden until the hint or the viewer says otherwise.
 */
export function showSignedOutIntro(
  hint: AuthHint,
  signedIn: boolean | null
): boolean {
  if (signedIn === true) return false;
  if (signedIn === false) return true;
  return hint === "out";
}

/** What the header slot shows before, and after, `/api/viewer`. */
export function headerAuthKind(
  hint: AuthHint,
  identity: { signedIn: boolean } | null
): "sign-in" | "account" | "reserved" {
  if (identity?.signedIn) return "account";
  if (identity && !identity.signedIn) return "sign-in";
  if (hint === "out") return "sign-in";
  if (hint === "in") return "account";
  return "reserved";
}
