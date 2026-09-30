import { describe, expect, it } from "vitest";
import {
  clipCountdown,
  displayMediaAudioConstraints,
  lockTabAudioTrack,
  playbackAdvanced,
  recordingShouldStop,
  streamHasAudio,
  tabAudioCaptureSupport,
  tabRecorderOptions,
  youtubeEmbedPlayerVars,
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
  it("asks for this tab with voice processing off", () => {
    const constraints = displayMediaAudioConstraints();
    expect(constraints.audio).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      suppressLocalAudioPlayback: false,
      channelCount: 2,
      sampleRate: 48_000,
    });
    expect(constraints.preferCurrentTab).toBe(true);
    expect(constraints.selfBrowserSurface).toBe("include");
    expect(constraints.systemAudio).toBe("exclude");
  });

  it("re-applies the processing flags and reports before and after", async () => {
    const applied: MediaTrackConstraints[] = [];
    let calls = 0;
    const track = {
      applyConstraints: async (constraints: MediaTrackConstraints) => {
        applied.push(constraints);
      },
      getSettings: (): MediaTrackSettings => {
        calls += 1;
        return calls === 1
          ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48_000 }
          : {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
              sampleRate: 48_000,
              channelCount: 2,
            };
      },
    };
    const locked = await lockTabAudioTrack(track);
    expect(locked.before.echoCancellation).toBe(true);
    expect(locked.after).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
      sampleRate: 48_000,
    });
    expect(applied[0]).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      suppressLocalAudioPlayback: false,
    });
  });

  it("records Opus at 256 kbps", () => {
    expect(tabRecorderOptions(() => true)).toEqual({
      mimeType: "audio/webm;codecs=opus",
      audioBitsPerSecond: 256_000,
    });
    expect(tabRecorderOptions(() => false)).toEqual({
      mimeType: "audio/webm",
      audioBitsPerSecond: 256_000,
    });
  });

  it("counts down a short clip", () => {
    expect(clipCountdown(0, 20)).toEqual({ leftSec: 20, ratio: 0 });
    expect(clipCountdown(7.2, 20).leftSec).toBe(13);
    expect(clipCountdown(20, 20)).toEqual({ leftSec: 0, ratio: 1 });
  });

  it("asks the embed for 720p audio", () => {
    expect(youtubeEmbedPlayerVars("https://echomancer.xyz").vq).toBe("hd720");
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
