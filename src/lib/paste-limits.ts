/**
 * Shared paste ceiling. The landing page and `POST /api/text/upload` both
 * use these so the counter and the rejection stay in step.
 */

export const PASTE_MIN_CHARS = 50;
export const PASTE_MAX_CHARS = 500_000;
