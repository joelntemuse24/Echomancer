/**
 * How a clone batch returns its audio.
 *
 * `inline` is the deployed container: each row is `audio_b64`, and a warm
 * page has to stay under the 80 MiB JSON ceiling. `r2` is the container
 * that uploads each MP3 and returns `storage_key`. The worker accepts both.
 * It plans a 24-row page only after `/ready` reports `r2`, or when a test
 * sets `MODAL_S2_AUDIO_TRANSPORT=r2`. The current app does not report it,
 * so a worker on this code still sends the smaller inline page.
 */

export type ModalCloneAudioTransport = "inline" | "r2";

let noted: ModalCloneAudioTransport = "inline";

export function noteModalCloneAudioTransport(value: unknown): void {
  noted = value === "r2" ? "r2" : "inline";
}

export function resetModalCloneAudioTransportForTests(): void {
  noted = "inline";
}

export function modalCloneAudioTransport(
  env: NodeJS.ProcessEnv = process.env
): ModalCloneAudioTransport {
  const raw = (env.MODAL_S2_AUDIO_TRANSPORT ?? "").trim();
  if (raw === "r2" || raw === "inline") return raw;
  return noted;
}
