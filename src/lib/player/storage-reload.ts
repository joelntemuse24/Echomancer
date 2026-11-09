/** HTMLMediaElement.error.code. */
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

/**
 * One recovery of a same-origin `/api/storage` URL.
 *
 * Network and unsupported-src (2, 4) are how an expired signature or a
 * cached redirect onto R2 shows up. Decode (3) is how a cached body that
 * still includes the ID3 tag fails before a click. The player asks again
 * with a new cache key. An abort (1) is not that.
 */
export function shouldReloadStorageAfterError(input: {
  src: string | null;
  errorCode: number | null;
  alreadyReloaded: boolean;
}): boolean {
  if (input.alreadyReloaded) return false;
  if (!input.src?.startsWith("/api/storage/")) return false;
  return (
    input.errorCode === MEDIA_ERR_NETWORK ||
    input.errorCode === MEDIA_ERR_DECODE ||
    input.errorCode === MEDIA_ERR_SRC_NOT_SUPPORTED
  );
}
