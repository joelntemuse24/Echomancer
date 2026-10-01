/**
 * Shared paste ceiling. The landing page and `POST /api/text/upload` both
 * use these so the counter and the rejection stay in step.
 */

export const PASTE_MIN_CHARS = 50;
export const PASTE_MAX_CHARS = 500_000;

/**
 * A fetched book is not limited by the JSON paste body. Eight million
 * characters covers a long novel such as War and Peace (~3.2 million).
 */
export const URL_MAX_CHARS = 8_000_000;

/**
 * Bytes read from the link itself. A Gutenberg plain-text file is about
 * 3.3 MB; 16 MB leaves room for a longer download without raising the
 * character ceiling above.
 */
export const URL_MAX_BYTES = 16 * 1024 * 1024;
