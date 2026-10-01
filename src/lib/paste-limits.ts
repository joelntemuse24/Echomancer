/**
 * Shared paste ceiling. The landing page and `POST /api/text/upload` both
 * use these so the counter and the rejection stay in step.
 */

export const PASTE_MIN_CHARS = 50;
export const PASTE_MAX_CHARS = 500_000;

/**
 * A fetched book is not limited by the JSON paste body. Two million
 * characters covers a long novel (Pride and Prejudice is about 750k).
 */
export const URL_MAX_CHARS = 2_000_000;
