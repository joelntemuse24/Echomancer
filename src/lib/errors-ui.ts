/**
 * Translate raw backend error messages into user-friendly strings.
 * Shared between queue page and player page.
 */

/** One count. The old sentence named the hole and the remainder separately. */
export function incompleteAudiobookMessage(done: number, total: number): string {
  const verb = done === 1 ? "was" : "were";
  return `${done} of ${total} sections ${verb} narrated. This is not a complete audiobook. Retry to generate the rest.`;
}

const VOICE_COULD_NOT_FINISH = "This voice couldn't finish the book. Try again.";

const OLD_INCOMPLETE =
  /^(\d+) of (\d+) sections could not be narrated\. Only (\d+) sections? of this book exist/i;

const READY_HOLE_WARNING =
  /^\d+ sections? could not be narrated; the rest of the book is ready\.?$/i;

function rewriteStoredBookError(rawError: string): string | null {
  const incomplete = OLD_INCOMPLETE.exec(rawError.trim());
  if (incomplete) {
    return incompleteAudiobookMessage(Number(incomplete[3]), Number(incomplete[2]));
  }
  const lower = rawError.toLowerCase();
  if (
    /^section\s+\d+\s*:/i.test(rawError) ||
    lower.includes("modal clone already retried")
  ) {
    return VOICE_COULD_NOT_FINISH;
  }
  return null;
}

/**
 * What the library and the player show under a status badge.
 * A ready book does not also say sections could not be narrated.
 */
export function customerBookStatus(
  raw: string | null | undefined,
  status?: string | null
): string | null {
  const text = raw?.trim() ?? "";
  if (!text) return null;
  if (status === "ready" && READY_HOLE_WARNING.test(text)) return null;
  const shown = userFriendlyError(text);
  return shown.trim() ? shown : null;
}

export function userFriendlyError(rawError: string | null): string {
  if (!rawError) return "Couldn't generate. Try again.";
  const rewritten = rewriteStoredBookError(rawError);
  if (rewritten) return rewritten;
  const lower = rawError.toLowerCase();
  if (
    lower.includes("isn't good enough to clone") ||
    lower.includes("re-record a fresh sample") ||
    lower.includes("too much echo to clone") ||
    lower.includes("cleaning it up won't help")
  ) {
    return rawError;
  }
  if (
    lower.includes("still being prepared") ||
    lower.includes("text_not_ready")
  ) {
    return "Still preparing. Try again in a moment.";
  }
  if (
    lower.includes("scanned") ||
    lower.includes("could not extract text") ||
    lower.includes("extraction_failed") ||
    lower.includes("drm-protected")
  )
    return "Couldn't read this. Try another file.";
  if (lower.includes("drm") || lower.includes("drm-protected"))
    return "This document is locked.";
  if (
    lower.includes("openrouter_api_key") ||
    lower.includes("fish_api_key") ||
    lower.includes("fish audio") ||
    lower.includes("fish tts") ||
    lower.includes("live fish") ||
    lower.includes("not configured")
  )
    return "Narration is unavailable. Try again later.";
  if (
    lower.includes("insufficient credits") ||
    lower.includes("payment required") ||
    lower.includes("402") ||
    lower.includes("credit balance") ||
    lower.includes("out of credits") ||
    (lower.includes("credits") && (lower.includes("exhausted") || lower.includes("depleted")))
  )
    return "Out of credit. Try later, or pick another voice.";
  if (
    lower.includes("stream finished") ||
    lower.includes("end of book")
  )
    return "This listen is over. Save the book.";
  if (lower.includes("stream budget") || lower.includes("budget exhausted"))
    return "Listen limit reached. Save the book.";
  if (lower.includes("stream session is not in a streamable") || lower.includes("not a stream"))
    return "This listen isn't ready. Open it from your library.";
  // The book shortfall is our own sentence. It contains "narrated" and
  // "generate", and the old matcher treated any "rate" inside those words
  // as a 429. The player then showed "Too fast. Wait a minute." for a
  // failed section. A real rate limit still matches below.
  if (lower.includes("could not be narrated")) return rawError;
  if (
    lower.includes("too many") ||
    lower.includes("rate limit") ||
    lower.includes("ratelimit") ||
    lower.includes("rate_limit") ||
    lower.includes("429")
  )
    return "Too fast. Wait a minute.";
  if (lower.includes("hd voices") || lower.includes("premium"))
    return "Pick Andrew, Ava, Libby, or Ryan.";
  if (lower.includes("no audio sections") || lower.includes("no valid audio") || lower.includes("no text to synthesize"))
    return "Nothing was spoken. The file may be empty.";
  if (lower.includes("cancelled by user"))
    return "Cancelled.";
  if (lower.includes("partial failure"))
    return "Part of the book was made. Try again.";
  if (
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("timeout") ||
    lower.includes("temporarily unavailable")
  )
    return "Narration was unavailable. Try again in a few minutes.";
  if (lower.includes("401") || lower.includes("403") || lower.includes("unauthorized"))
    return "Couldn't authorize narration. Try again later.";
  if (lower.includes("could not find file in options"))
    return "Couldn't read this Word file. Try PDF or paste.";
  if (lower.includes("unsupported document format"))
    return "Use PDF, EPUB, DOCX, TXT, or RTF.";
  if (lower.includes("validation error") || lower.includes("422"))
    return "That voice rejected the request. Pick another.";
  if (lower.includes("failed to download") || lower.includes("failed to upload"))
    return "The file didn't transfer. Try again.";
  if (lower.includes("empty"))
    return "That file is empty. Choose another.";
  if (lower.includes("job not found"))
    return "This audiobook is gone.";
  if (lower.includes("live stream") || lower.includes("live listen"))
    return "Couldn't play that. Try again.";
  if (lower.includes("spoken takes are kept") || lower.includes("workspace is disabled"))
    return rawError;
  // Truncate very long / provider-leaky errors
  if (rawError.length > 120) return "Something went wrong. Try again.";
  return rawError;
}
