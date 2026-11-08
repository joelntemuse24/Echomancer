import { describe, expect, it } from "vitest";
import {
  START_FAILED_NOTICE,
  START_RECOVERY_LIMIT,
  START_WATCHDOG_MS,
  mediaSnapshot,
  planStart,
  startFailureNotice,
  startIsStuck,
  type MediaSnapshot,
} from "@/lib/player/audio-start";

/**
 * The production bug: the main Play button did nothing at all — icon still
 * Play, clock still 0:00, no notice — until a Parts row was tapped.
 *
 * The audio element was one of two unreportable states, and `audio.play()`
 * could not say so. These cases pin the states and the repair.
 */

/** `HAVE_NOTHING` + `NETWORK_NO_SOURCE` with a media error: source selection failed. */
function failedSource(code = 4): MediaSnapshot {
  return {
    paused: true,
    currentTime: 0,
    readyState: 0,
    networkState: 3,
    errorCode: code,
    bufferedEnd: 0,
  };
}

/** The healthy middle: metadata in hand, playing. */
function playing(at = 12.4): MediaSnapshot {
  return {
    paused: false,
    currentTime: at,
    readyState: 4,
    networkState: 1,
    errorCode: null,
    bufferedEnd: at,
  };
}

/** Called `play()` on a good element; the request is still in flight. */
function pending(at = 0): MediaSnapshot {
  return {
    paused: false,
    currentTime: at,
    readyState: 2,
    networkState: 2,
    errorCode: null,
    bufferedEnd: 0,
  };
}

describe("planStart", () => {
  it("plays a healthy element instead of reloading it", () => {
    expect(planStart(playing(), 0)).toBe("play");
    expect(planStart(pending(), 0)).toBe("play");
  });

  it("reloads an element whose source selection failed", () => {
    // Tapping Play alone cannot recover this: play() rejects every time.
    expect(planStart(failedSource(4), 0)).toBe("reload-and-play");
    expect(planStart(failedSource(2), 0)).toBe("reload-and-play");
  });

  it("gives up after the recovery is spent, so the listener is told", () => {
    expect(planStart(failedSource(), START_RECOVERY_LIMIT)).toBe("unavailable");
  });

  it("treats a source-less element as failed even without an error object", () => {
    const noSource: MediaSnapshot = { ...pending(), networkState: 3 };
    expect(planStart(noSource, 0)).toBe("reload-and-play");
  });

  it("reloads when the watchdog asks, since the element looks healthy but stalls", () => {
    expect(planStart(pending(), 0, true)).toBe("reload-and-play");
    expect(planStart(pending(), START_RECOVERY_LIMIT, true)).toBe("unavailable");
  });

  it("does not reload a healthy element the watchdog did not flag", () => {
    expect(planStart(playing(), 0, false)).toBe("play");
  });
});

describe("startIsStuck", () => {
  it("waits out the window before calling a start stuck", () => {
    expect(startIsStuck(pending(0), pending(0), START_WATCHDOG_MS - 1)).toBe(false);
  });

  it("flags a start that never moved and never buffered", () => {
    // The production shape: paused is already false, nothing else happened.
    expect(startIsStuck(pending(0), pending(0), START_WATCHDOG_MS)).toBe(true);
  });

  it("leaves a start alone while the buffer is still growing", () => {
    // A long uncached file can sit below HAVE_FUTURE_DATA at 0:00 while
    // bytes are arriving. Aborting that load is the "couldn't play" notice.
    const growing = { ...pending(0), bufferedEnd: 4 };
    expect(startIsStuck(pending(0), growing, START_WATCHDOG_MS)).toBe(false);
  });

  it("leaves a start alone once the playhead moves", () => {
    expect(startIsStuck(pending(0), pending(0.8), START_WATCHDOG_MS)).toBe(false);
  });

  it("leaves a start alone once the element has data to play on", () => {
    const ready: MediaSnapshot = { ...pending(0), readyState: 3 };
    expect(startIsStuck(pending(0), ready, START_WATCHDOG_MS)).toBe(false);
  });

  it("does not flag a mid-section start at a real position", () => {
    // A resume from 41 s that has moved is a real resume, not a stuck start.
    expect(startIsStuck(pending(41), pending(43.2), START_WATCHDOG_MS)).toBe(false);
  });

  it("flags a mid-section resume that never moved either", () => {
    // The reload lost the socket: being at 41 s is not the same as progressing.
    expect(startIsStuck(pending(41), pending(41.01), START_WATCHDOG_MS)).toBe(true);
  });
});

describe("startFailureNotice", () => {
  it("stays quiet for the player's own interruptions", () => {
    // A newer load, a section switch, or our pause is not an error.
    expect(startFailureNotice(new DOMException("interrupted", "AbortError"))).toBeNull();
    expect(
      startFailureNotice(
        new Error(
          "The play() request was interrupted by a new load request. https://goo.gl/LdLk22"
        )
      )
    ).toBeNull();
  });

  it("asks for a second tap when autoplay was blocked", () => {
    expect(
      startFailureNotice(new DOMException("blocked", "NotAllowedError"))
    ).toBe("Tap play again.");
  });

  it("reports a real failure", () => {
    expect(
      startFailureNotice(new DOMException("no source", "NotSupportedError"))
    ).toBe(START_FAILED_NOTICE);
  });
});

describe("mediaSnapshot", () => {
  it("reads the element fields the decisions depend on", () => {
    expect(
      mediaSnapshot({
        paused: true,
        currentTime: 3,
        readyState: 4,
        networkState: 1,
        error: null,
      })
    ).toEqual({
      paused: true,
      currentTime: 3,
      readyState: 4,
      networkState: 1,
      errorCode: null,
      bufferedEnd: 0,
    });
    expect(
      mediaSnapshot({
        paused: true,
        currentTime: 3,
        readyState: 4,
        networkState: 1,
        error: null,
        buffered: { length: 1, end: () => 8 },
      }).bufferedEnd
    ).toBe(8);
  });

  it("carries the media error code through", () => {
    expect(
      mediaSnapshot({
        paused: true,
        currentTime: 0,
        readyState: 0,
        networkState: 3,
        error: { code: 4 },
      }).errorCode
    ).toBe(4);
  });
});
