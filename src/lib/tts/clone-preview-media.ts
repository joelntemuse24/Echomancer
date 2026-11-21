/**
 * Cookie-free URL for one clone's stored preview MP3.
 *
 * The voices list checks ownership, then hands out this URL. The bytes
 * route checks the signature and nothing else: no session, no cookie, so
 * the edge can cache the response. The path is confined to
 * `previews/clones/<id>/<hash>.mp3`. A signature over any other key is
 * rejected, and the HMAC uses the session secret so the URL cannot be
 * guessed from the clone id.
 */

import { createHmac, timingSafeEqual } from "crypto";

import { getSessionSecret } from "@/lib/auth/session";

/** Domain separator so a session cookie MAC cannot be replayed here. */
const MEDIA_PREFIX = "echomancer-clone-preview-v1";

/** `~` is not part of base64url, so the path segment has no file extension. */
const TOKEN_SEPARATOR = "~";

export const CLONE_PREVIEW_MEDIA_CACHE = "public, max-age=31536000, immutable";

const PREVIEW_OBJECT_PATH =
  /^previews\/clones\/[A-Za-z0-9_-]{1,80}\/[a-f0-9]{32}\.mp3$/;

export function isClonePreviewObjectPath(storagePath: string): boolean {
  return PREVIEW_OBJECT_PATH.test(storagePath);
}

export function isClonePreviewMediaRequestPath(pathname: string): boolean {
  return pathname.startsWith("/api/tts/clone-preview/");
}

function mac(storagePath: string): Buffer {
  return createHmac("sha256", getSessionSecret())
    .update(MEDIA_PREFIX)
    .update("\0")
    .update(storagePath)
    .digest();
}

/** Unguessable token for one preview object, or null when the path is not one. */
export function signClonePreviewMediaToken(storagePath: string): string | null {
  if (!isClonePreviewObjectPath(storagePath)) return null;
  const payload = Buffer.from(storagePath, "utf8").toString("base64url");
  return `${payload}${TOKEN_SEPARATOR}${mac(storagePath).toString("base64url")}`;
}

/** Same-origin URL. Empty when the path is not a clone preview object. */
export function clonePreviewMediaUrl(storagePath: string): string {
  const token = signClonePreviewMediaToken(storagePath);
  if (!token) return "";
  return `/api/tts/clone-preview/${encodeURIComponent(token)}`;
}

/**
 * The object key a token names, or null when the signature, the encoding,
 * or the path shape is wrong.
 */
export function verifyClonePreviewMediaToken(token: string): string | null {
  if (!token || token.length > 512) return null;
  const split = token.indexOf(TOKEN_SEPARATOR);
  if (split <= 0 || split !== token.lastIndexOf(TOKEN_SEPARATOR)) return null;
  const payload = token.slice(0, split);
  const sigPart = token.slice(split + 1);
  if (!payload || !sigPart) return null;
  let storagePath: string;
  let sig: Buffer;
  try {
    storagePath = Buffer.from(payload, "base64url").toString("utf8");
    sig = Buffer.from(sigPart, "base64url");
  } catch {
    return null;
  }
  if (!isClonePreviewObjectPath(storagePath)) return null;
  const expected = mac(storagePath);
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(sig, expected)) return null;
  return storagePath;
}
