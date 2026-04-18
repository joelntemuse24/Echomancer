/**
 * Translate raw backend error messages into user-friendly strings.
 * Shared between queue page and player page.
 */
export function userFriendlyError(rawError: string | null): string {
  if (!rawError) return "Generation failed. Please try again.";
  const lower = rawError.toLowerCase();
  if (lower.includes("scanned") || lower.includes("could not extract text"))
    return "Could not read text from this document. It may be a scanned PDF or image-based file.";
  if (lower.includes("drm") || lower.includes("drm-protected"))
    return "This document is DRM-protected and cannot be processed.";
  if (lower.includes("voice sample too short"))
    return "Voice sample too short. Please select a clip of at least 3 seconds.";
  if (lower.includes("no voice samples"))
    return "No voice sample was provided. Please upload or select a voice.";
  if (lower.includes("no audio sections") || lower.includes("no valid audio"))
    return "Audio generation produced no output. The document may be empty or the voice sample unusable.";
  if (lower.includes("cancelled by user"))
    return "Cancelled by you.";
  if (lower.includes("partial failure"))
    return "Generation partially failed. Some sections were completed but the full audiobook could not be assembled.";
  if (lower.includes("modal") || lower.includes("502") || lower.includes("503") || lower.includes("timeout"))
    return "The AI service was temporarily unavailable. Please try again in a few minutes.";
  if (lower.includes("unsupported document format"))
    return "This file format is not supported. Please use PDF, EPUB, DOCX, TXT, or RTF.";
  if (lower.includes("failed to download") || lower.includes("failed to upload"))
    return "A file transfer error occurred. Please try again.";
  if (lower.includes("empty"))
    return "The uploaded file appears to be empty.";
  // Truncate very long errors
  if (rawError.length > 120) return rawError.slice(0, 117) + "...";
  return rawError;
}
