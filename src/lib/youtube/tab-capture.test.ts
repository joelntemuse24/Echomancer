import { describe, expect, it } from "vitest";
import {
  displayMediaAudioConstraints,
  playbackAdvanced,
  recordingShouldStop,
  streamHasAudio,
  tabAudioCaptureSupport,
} from "./tab-capture";
import { floatToWavBytes } from "./wav-bytes";

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0";
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const FIREFOX =
  "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";

describe("tabAudioCaptureSupport", () => {
  const yes = { hasGetDisplayMedia: true, maxTouchPoints: 0 };

  it("allows desktop Chromium", () => {
    expect(tabAudioCaptureSupport({ ...yes, userAgent: CHROME })).toBe("supported");
    expect(tabAudioCaptureSupport({ ...yes, userAgent: EDGE })).toBe("supported");
  });

  it("refuses iOS, Android, Safari, and Firefox", () => {
    expect(tabAudioCaptureSupport({ ...yes, userAgent: SAFARI_IOS })).toBe("unsupported");
    expect(tabAudioCaptureSupport({ ...yes, userAgent: CHROME_ANDROID })).toBe("unsupported");
    expect(tabAudioCaptureSupport({ ...yes, userAgent: SAFARI_MAC })).toBe("unsupported");
    expect(tabAudioCaptureSupport({ ...yes, userAgent: FIREFOX })).toBe("unsupported");
    expect(
      tabAudioCaptureSupport({
        userAgent: CHROME,
        hasGetDisplayMedia: false,
      })
    ).toBe("unsupported");
    expect(
      tabAudioCaptureSupport({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        platform: "MacIntel",
        maxTouchPoints: 5,
        hasGetDisplayMedia: true,
      })
    ).toBe("unsupported");
  });
});

describe("recording window", () => {
  it("stops at the range end and not before", () => {
    expect(
      recordingShouldStop({
        startSec: 10,
        endSec: 40,
        currentTime: 20,
        elapsedSec: 10,
      })
    ).toBe(false);
    expect(
      recordingShouldStop({
        startSec: 10,
        endSec: 40,
        currentTime: 39.96,
        elapsedSec: 30,
      })
    ).toBe(true);
  });

  it("stops if the player clock never reaches the end", () => {
    expect(
      recordingShouldStop({
        startSec: 10,
        endSec: 40,
        currentTime: 10,
        elapsedSec: 31.5,
      })
    ).toBe(true);
  });

  it("knows whether playback moved", () => {
    expect(playbackAdvanced(10, 10.1)).toBe(false);
    expect(playbackAdvanced(10, 11)).toBe(true);
  });
});

describe("display media request", () => {
  it("asks for this tab and its audio", () => {
    const constraints = displayMediaAudioConstraints();
    expect(constraints.audio).toBe(true);
    expect(constraints.preferCurrentTab).toBe(true);
    expect(constraints.selfBrowserSurface).toBe("include");
    expect(constraints.systemAudio).toBe("exclude");
  });

  it("requires an audio track on the shared stream", () => {
    expect(streamHasAudio({ getAudioTracks: () => [] })).toBe(false);
    expect(streamHasAudio({ getAudioTracks: () => [{}] })).toBe(true);
  });
});

describe("floatToWavBytes", () => {
  it("writes a mono 16-bit wav header", () => {
    const wav = floatToWavBytes(new Float32Array([0, 0.5, -0.5]), 44100);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
    expect(wav.byteLength).toBe(44 + 6);
  });
});
