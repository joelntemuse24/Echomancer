/**
 * AudioContexts this app created, so a background suspension can be undone.
 *
 * The player itself does not route the media element through Web Audio: a
 * cross-origin `<audio>` source would play silence through a graph, and the
 * presigned R2 playback URL is cross-origin. Nothing here is needed for
 * playback to be heard. It exists so any graph the app does open (the clone
 * sample decoder on the Voices screen) cannot leave a suspended context
 * behind that mutes a later listen.
 */

type ResumableAudioContext = {
  state?: string;
  resume?: () => Promise<void>;
  close?: () => Promise<void>;
};

const contexts = new Set<ResumableAudioContext>();

/** Start tracking a context. The returned function stops tracking it. */
export function trackAudioContext(context: ResumableAudioContext): () => void {
  contexts.add(context);
  return () => {
    contexts.delete(context);
  };
}

/**
 * Resume every tracked context that the browser suspended. Returns whether
 * anything was actually suspended, which is what a caller would log.
 */
export async function resumeAudioGraphs(): Promise<boolean> {
  let resumed = false;
  for (const context of contexts) {
    if (context.state !== "suspended") continue;
    if (typeof context.resume !== "function") continue;
    try {
      await context.resume();
      resumed = true;
    } catch {
      // A context that refuses to resume is not the media element's problem.
    }
  }
  return resumed;
}

/** How many contexts are tracked right now. Used by tests and diagnostics. */
export function trackedAudioGraphCount(): number {
  return contexts.size;
}
