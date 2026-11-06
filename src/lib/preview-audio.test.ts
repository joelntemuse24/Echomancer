/**
 * The preview picker's audio rules: one element, and our own pause is not an
 * error.
 *
 * The production symptom was a toast reading "The play() request was
 * interrupted by a call to pause()" — a rejected `play()` promise caused by
 * the app pausing its own element while a later tap replaced it. These tests
 * pin the behaviour rather than the implementation: a pause we caused may only
 * ever surface as `"interrupted"`, never as `onError`, and a superseded
 * attempt must not report a failure over the preview that replaced it.
 */

import { describe, expect, it, vi } from "vitest";
import {
  PreviewAudioController,
  isPlayInterruption,
  type PreviewAudioElement,
} from "@/lib/preview-audio";

/** Matches Chrome's rejection for a play that a pause() superseded. */
function chromeInterruption(): DOMException {
  return new DOMException(
    "The play() request was interrupted by a call to pause(). https://goo.gl/LdLk22",
    "AbortError"
  );
}

/** Let the controller's microtasks (and the for-of over sources) advance. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type FakeElement = PreviewAudioElement & {
  pauseCalls: number;
  resolvePlay: () => void;
  rejectPlay: (error: unknown) => void;
};

function fakeElement(): FakeElement {
  const element: FakeElement = {
    src: "",
    pauseCalls: 0,
    resolvePlay: () => {},
    rejectPlay: () => {},
    onplaying: null,
    onended: null,
    onerror: null,
    play() {
      return new Promise<void>((resolve, reject) => {
        element.resolvePlay = () => resolve();
        element.rejectPlay = (error) => reject(error);
      });
    },
    pause() {
      element.pauseCalls += 1;
      // The browser rejects the pending play() when it is paused mid-load.
      element.rejectPlay(chromeInterruption());
    },
  };
  return element;
}

function controller() {
  const created: FakeElement[] = [];
  const audio = new PreviewAudioController(() => {
    const element = fakeElement();
    created.push(element);
    return element;
  });
  return { audio, created };
}

describe("isPlayInterruption", () => {
  it("recognises Chrome's pause() wording", () => {
    expect(
      isPlayInterruption(
        new Error(
          "The play() request was interrupted by a call to pause(). https://goo.gl/LdLk22"
        )
      )
    ).toBe(true);
  });

  it("recognises a load-request interruption and a bare AbortError", () => {
    expect(
      isPlayInterruption(
        new Error("The play() request was interrupted by a new load request.")
      )
    ).toBe(true);
    expect(isPlayInterruption(new DOMException("paused", "AbortError"))).toBe(true);
  });

  it("does not swallow a real playback failure", () => {
    expect(
      isPlayInterruption(new DOMException("no source", "NotSupportedError"))
    ).toBe(false);
    expect(
      isPlayInterruption(new Error("NotAllowedError: user gesture required"))
    ).toBe(false);
    expect(isPlayInterruption(null)).toBe(false);
    expect(isPlayInterruption("nope")).toBe(false);
  });
});

describe("PreviewAudioController", () => {
  it("plays a stored source and reports the end exactly once", async () => {
    const { audio, created } = controller();
    const onEnd = vi.fn();
    const onError = vi.fn();

    const playing = audio.play(["/api/tts/clones/clone:abc/preview"], {
      onEnd,
      onError,
    });
    created[0]!.resolvePlay();
    await expect(playing).resolves.toBe("played");

    created[0]!.onended?.();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(audio.active).toBe(false);
  });

  it("falls through to the generator when no clip is stored", async () => {
    const { audio, created } = controller();
    const playing = audio.play([
      "/api/tts/clones/clone:abc/preview",
      "/api/tts/live?catalogVoiceId=clone:abc",
    ]);

    // A 404 from the stored-clip route reaches the media element as `error`.
    created[0]!.onerror?.();
    await flush();
    created[0]!.resolvePlay();

    await expect(playing).resolves.toBe("played");
    expect(created[0]!.src).toBe("/api/tts/live?catalogVoiceId=clone:abc");
    // One element, reused: a second element per tap is what caused the race.
    expect(created).toHaveLength(1);
  });

  it("reports a failure only after every source fails", async () => {
    const { audio, created } = controller();
    const onError = vi.fn();
    const playing = audio.play(["a", "b"], { onError });

    created[0]!.onerror?.();
    await flush();
    created[0]!.onerror?.();

    await expect(playing).resolves.toBe("failed");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("treats our own pause() as an interruption, never an error", async () => {
    const { audio, created } = controller();
    const onError = vi.fn();
    const playing = audio.play(["/api/tts/live?catalogVoiceId=clone:abc"], {
      onError,
    });

    // The person taps the row again while `play()` is still pending.
    audio.stop();

    await expect(playing).resolves.toBe("interrupted");
    expect(onError).not.toHaveBeenCalled();
    expect(created[0]!.pauseCalls).toBe(1);
  });

  it("reports a superseded preview as interrupted, not failed", async () => {
    const { audio, created } = controller();
    const firstOnError = vi.fn();

    const first = audio.play(["slow"], { onError: firstOnError });
    const second = audio.play(["fast", "later"]);

    await expect(first).resolves.toBe("interrupted");
    expect(firstOnError).not.toHaveBeenCalled();

    // Only the newest generation owns the element's events.
    created[0]!.resolvePlay();
    await expect(second).resolves.toBe("played");
    expect(audio.active).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]!.src).toBe("fast");
  });

  it("reports a failure when there is no source at all", async () => {
    const { audio, created } = controller();
    const onError = vi.fn();
    await expect(audio.play([], { onError })).resolves.toBe("failed");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(0);
  });

  it("keeps a real play() rejection as a failure", async () => {
    const { audio, created } = controller();
    const onError = vi.fn();
    const playing = audio.play(["only"], { onError });

    // Not an AbortError: the browser refused to start playback.
    created[0]!.rejectPlay(new DOMException("blocked", "NotAllowedError"));

    await expect(playing).resolves.toBe("failed");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(audio.active).toBe(false);
  });

  it("stops cleanly when nothing is playing", () => {
    const { audio } = controller();
    expect(() => audio.stop()).not.toThrow();
    expect(audio.active).toBe(false);
  });
});
