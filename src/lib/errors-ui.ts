/**
 * Translate raw backend error messages into user-friendly strings.
 * Shared between queue page and player page.
 */
export function userFriendlyError(rawError: string | null): string {
  if (!rawError) return "Generation failed. Please try again.";
  const lower = rawError.toLowerCase();
  if (
    lower.includes("scanned") ||
    lower.includes("could not extract text") ||
    lower.includes("extraction_failed") ||
    lower.includes("drm-protected")
  )
    return "Could not read text from this document. It may be a scanned PDF, image-based file, or DRM-protected ebook.";
  if (lower.includes("drm") || lower.includes("drm-protected"))
    return "This document is DRM-protected and cannot be processed.";
  if (lower.includes("openrouter_api_key") || lower.includes("not configured"))
    return "Narration is temporarily unavailable. Please try again later.";
  if (
    lower.includes("insufficient credits") ||
    lower.includes("payment required") ||
    lower.includes("402") ||
    lower.includes("credit balance") ||
    lower.includes("out of credits") ||
    (lower.includes("credits") && (lower.includes("exhausted") || lower.includes("depleted")))
  )
    return "Narration credits ran out. Please try again later, or pick a different narrator.";
  if (lower.includes("stream budget") || lower.includes("budget exhausted") || lower.includes("book finished"))
    return "Live listen limit reached. Generate a full take-home copy to keep listening.";
  if (lower.includes("stream session is not in a streamable") || lower.includes("not a stream"))
    return "This live session isn't ready. Open it again from your library, or generate a full copy.";
  if (lower.includes("too many") || lower.includes("rate") || lower.includes("429"))
    return "You're doing that too quickly. Please wait a minute and try again.";
  if (lower.includes("hd voices") || lower.includes("premium"))
    return "That narrator is a premium HD voice. Pick a standard narrator, or ask for HD access.";
  if (lower.includes("voice sample too short"))
    return "Voice sample too short. Please select a clip of at least 3 seconds.";
  if (lower.includes("no voice samples"))
    return "No voice sample was provided. Please upload or select a voice.";
  if (lower.includes("no audio sections") || lower.includes("no valid audio") || lower.includes("no text to synthesize"))
    return "Audio generation produced no output. The document may be empty.";
  if (lower.includes("cancelled by user"))
    return "Cancelled by you.";
  if (lower.includes("partial failure"))
    return "Generation partially failed. Some sections were completed but the full audiobook could not be assembled.";
  if (
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("timeout") ||
    lower.includes("temporarily unavailable")
  )
    return "The narration service was temporarily unavailable. Please try again in a few minutes.";
  if (lower.includes("401") || lower.includes("403") || lower.includes("unauthorized"))
    return "Narration could not be authorized. Please try again later.";
  if (lower.includes("unsupported document format"))
    return "This file format is not supported. Please use PDF, EPUB, DOCX, TXT, or RTF.";
  if (lower.includes("validation error") || lower.includes("422"))
    return "The voice synthesis service received an invalid request. Please try a different voice.";
  if (lower.includes("cold-start") || lower.includes("starting up") || lower.includes("timed out (504)"))
    return "The voice synthesis service is warming up. Please try again in 2-3 minutes.";
  if (lower.includes("failed to download") || lower.includes("failed to upload"))
    return "A file transfer error occurred. Please try again.";
  if (lower.includes("empty"))
    return "The uploaded file appears to be empty.";
  if (lower.includes("job not found"))
    return "We couldn't find this audiobook. It may have been deleted.";
  // Truncate very long / provider-leaky errors
  if (rawError.length > 120) return "Something went wrong while generating audio. Please try again.";
  return rawError;
}
