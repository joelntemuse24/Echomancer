/**
 * A missing or forbidden book is final. A network blip or a 5xx is not:
 * the row already on screen can stay until the next try.
 */
export function detailFailureIsFinal(status: number | null | undefined): boolean {
  return status === 401 || status === 403 || status === 404;
}
