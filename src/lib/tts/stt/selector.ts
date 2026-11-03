/**
 * Speech-to-text providers for section QA.
 *
 * Two implementations behind one interface:
 *
 *   - `local`    — self-hosted Whisper on this CPU, via a Python sidecar.
 *                  No API key, no per-minute bill, no network egress for audio.
 *   - `deepgram` — the hosted `deepgram/nova-3` transcription on OpenRouter.
 *                  Kept as an explicit opt-in.
 *
 * The default is `local`. QA only needs the spoken words; nothing in the app
 * consumes a transcript's timings (read-along timing comes from MP3 frame
 * counts), so both providers return a plain string.
 */

export type SttProviderName = "local" | "deepgram";

export const DEFAULT_STT_PROVIDER: SttProviderName = "local";

/**
 * `TTS_QA_PROVIDER`:
 *   `local`    (default) self-hosted Whisper
 *   `deepgram` hosted Nova-3 through OpenRouter
 *   `off`      no transcript check at all
 *
 * A legacy `TTS_SECTION_QA_ENABLED=0` still forces `off`.
 */
export function resolveSttProvider(env: NodeJS.ProcessEnv = process.env): SttProviderName | null {
  if (qaTranscriptsDisabled(env)) return null;
  const raw = env.TTS_QA_PROVIDER?.trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false" || raw === "none") return null;
  if (raw === "deepgram" || raw === "openrouter" || raw === "nova") return "deepgram";
  if (raw === "local" || raw === "whisper" || raw === "self-hosted" || raw === "selfhosted") {
    return "local";
  }
  // Unset or unrecognised: Whisper. A typo must not silently move audio to a
  // paid endpoint, and must not silently turn QA off either.
  return DEFAULT_STT_PROVIDER;
}

/** `TTS_SECTION_QA_ENABLED=0` (or false/off) skips QA entirely. */
export function qaTranscriptsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.TTS_SECTION_QA_ENABLED?.trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "off" || raw === "no";
}
