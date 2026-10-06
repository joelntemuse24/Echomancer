/** HTMLMediaElement.error.code. Expired R2 signatures surface as 2 or 4. */
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

/**
 * One reload of the same-origin `/api/storage` URL after a network failure.
 * The element keeps seeking against the presigned R2 URL it followed, and
 * that signature dies after 12–13h. `load()` asks for `/api/storage` again,
 * which checks ownership and mints a new URL. A decode error or an abort
 * is not a stale signature.
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
    input.errorCode === MEDIA_ERR_SRC_NOT_SUPPORTED
  );
}
