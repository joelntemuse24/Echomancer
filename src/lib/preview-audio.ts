/**
 * One preview audio element, and never a toast for our own pause.
 *
 * A media element rejects a pending `play()` promise with an `AbortError`
 * ("The play() request was interrupted by a call to pause()") whenever that
 * playback is superseded: a second tap on the same row, a tap on another row,
 * a source swap, or an unload. `play()` stays pending until audio actually
 * starts, which for a clone can be many seconds — exactly the window in which
 * a person taps again. That rejection is normal control flow, not a failure,
 * and surfacing its raw message is what put
 *
 *   The play() request was interrupted by a call to pause(). https://goo.gl/LdLk22
 *
 * on screen.
 *
 * So a preview never builds a fresh element per tap: one element is kept for
 * the lifetime of the controller and only its `src` changes, which is the
 * shape the browser is built to handle. Every handler is additionally guarded
 * by a generation token, because an element reused for the next row would
 * otherwise let a stale `onended` or `onerror` clear the new row's spinner.
 *
 * The element factory is injected so these rules run under the node test
 * runner with a stand-in for `new Audio()`.
 */

export interface PreviewAudioElement {
  src: string;
  preload?: string;
  onplaying: EventListener | null;
  onended: EventListener | null;
  onerror: EventListener | null;
  play(): Promise<void>;
  pause(): void;
}

export interface PreviewPlayHandlers {
  /** Audio actually started. Fires once per successful play. */
  onStart?: () => void;
  /** Played to the end. */
  onEnd?: () => void;
  /** Every source failed. The only case worth telling the person about. */
  onError?: () => void;
}

export type PreviewOutcome = "played" | "interrupted" | "failed";

/**
 * Chrome's wording for a superseded play — "The play() request was
 * interrupted by a call to pause()" / "…by a new load request". Safari reports
 * the same condition as `AbortError`.
 */
const PLAY_INTERRUPTED_RE = /play\(\) request (?:was interrupted|failed because)/i;

/** True when a rejected `play()` only means the preview was stopped or replaced. */
export function isPlayInterruption(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === "AbortError") return true;
  return typeof message === "string" && PLAY_INTERRUPTED_RE.test(message);
}

export class PreviewAudioController {
  private element: PreviewAudioElement | null = null;
  private playing = false;
  private token = 0;

  constructor(private readonly createElement: () => PreviewAudioElement) {}

  /** A preview is pending or playing, so a second tap on it means stop. */
  get active(): boolean {
    return this.playing;
  }

  /** Stop whatever is playing. A pending `play()` resolves as interrupted. */
  stop(): void {
    this.token += 1;
    this.playing = false;
    const element = this.element;
    if (!element) return;
    this.clearHandlers(element);
    try {
      element.pause();
    } catch {
      /* the element is already gone */
    }
  }

  /**
   * Play the first source that works, in order.
   *
   * A saved clone passes its stored clip first and its generator second, so a
   * clone that already has audio never synthesizes again, and the first play
   * (nothing stored yet) falls through to the stream on a media error.
   */
  async play(
    sources: readonly string[],
    handlers: PreviewPlayHandlers = {}
  ): Promise<PreviewOutcome> {
    const urls = sources.filter(
      (src): src is string => typeof src === "string" && src.length > 0
    );
    this.stop();
    if (urls.length === 0) {
      handlers.onError?.();
      return "failed";
    }
    const token = this.token;
    this.playing = true;

    for (const url of urls) {
      const outcome = await this.attempt(url, token, handlers);
      if (outcome === "ok") return "played";
      if (outcome === "interrupt") return "interrupted";
    }
    // Only report a failure that still belongs to this generation: a superseded
    // attempt must not toast over the preview that replaced it.
    if (token === this.token) {
      this.playing = false;
      handlers.onError?.();
    }
    return "failed";
  }

  private attempt(
    url: string,
    token: number,
    handlers: PreviewPlayHandlers
  ): Promise<"ok" | "interrupt" | "retry"> {
    const element = this.element ?? (this.element = this.createElement());
    const alive = () => token === this.token;

    return new Promise((resolve) => {
      let settled = false;
      const settle = (value: "ok" | "interrupt" | "retry") => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      element.onplaying = () => {
        if (alive()) handlers.onStart?.();
      };
      element.onended = () => {
        if (!alive()) return;
        this.playing = false;
        handlers.onEnd?.();
      };
      element.onerror = () => {
        if (!alive()) return;
        settle("retry");
      };

      element.preload = "auto";
      let pending: Promise<void>;
      try {
        element.src = url;
        pending = element.play();
      } catch (error) {
        settle(isPlayInterruption(error) ? "interrupt" : "retry");
        return;
      }
      pending.then(
        () => settle("ok"),
        (error: unknown) => {
          // A newer play, or an explicit stop, already owns the state.
          if (token !== this.token) {
            settle("interrupt");
            return;
          }
          settle(isPlayInterruption(error) ? "interrupt" : "retry");
        }
      );
    });
  }

  private clearHandlers(element: PreviewAudioElement): void {
    element.onplaying = null;
    element.onended = null;
    element.onerror = null;
  }
}
