import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PLAYBACK_SPEED,
  PLAYBACK_SPEED_PRESETS,
  normalizePlaybackSpeed,
} from "./playback-speed";
import {
  SPEED_PREF_KEY,
  readNumberPref,
  resetPrefMemoryForTests,
  setNumberPref,
  writeNumberPref,
} from "./player-prefs";
import { readSpeedPref, writeSpeedPref } from "./playback-speed-pref";

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    dump: () => Object.fromEntries(data),
  };
}

beforeEach(() => {
  resetPrefMemoryForTests();
});

describe("stored playback speed", () => {
  it("keeps the chosen rate across a reload", () => {
    const store = memoryStore();
    writeSpeedPref(store, 1.25);
    // A reload is a fresh read of the same storage.
    expect(readSpeedPref(store)).toBe(1.25);
    expect(readSpeedPref(store)).not.toBe(DEFAULT_PLAYBACK_SPEED);
  });

  it("is one global key, not one per book", () => {
    const store = memoryStore();
    writeSpeedPref(store, 0.9);
    // Nothing in the key names a book, so the next book reads the same rate.
    expect(Object.keys(store.dump())).toEqual([SPEED_PREF_KEY]);
    expect(store.dump()[SPEED_PREF_KEY]).toBe("0.9");
    expect(readSpeedPref(store)).toBe(0.9);
  });

  it("defaults to 1× when nothing is stored or the store refuses", () => {
    expect(readSpeedPref(memoryStore())).toBe(1);
    expect(readSpeedPref(null)).toBe(1);
    const refuses = {
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => {
        throw new Error("private mode");
      },
    };
    expect(readSpeedPref(refuses)).toBe(1);
    expect(() => writeSpeedPref(refuses, 1.2)).not.toThrow();
  });

  it("snaps a stale or hand-edited value onto a real preset", () => {
    const store = memoryStore({ [SPEED_PREF_KEY]: "1.22" });
    expect(readSpeedPref(store)).toBe(1.2);
    expect(PLAYBACK_SPEED_PRESETS).toContain(readSpeedPref(store));
    expect(readSpeedPref(memoryStore({ [SPEED_PREF_KEY]: "9" }))).toBe(1.5);
    expect(readSpeedPref(memoryStore({ [SPEED_PREF_KEY]: "0.1" }))).toBe(0.8);
    expect(readSpeedPref(memoryStore({ [SPEED_PREF_KEY]: "fast" }))).toBe(1);
  });

  it("normalizes to a preset, keeping the 0.8–1.5 range in 0.05 steps", () => {
    expect(PLAYBACK_SPEED_PRESETS[0]).toBe(0.8);
    expect(PLAYBACK_SPEED_PRESETS.at(-1)).toBe(1.5);
    for (const rate of PLAYBACK_SPEED_PRESETS) {
      expect(normalizePlaybackSpeed(rate)).toBe(rate);
    }
    expect(normalizePlaybackSpeed(1.149999)).toBe(1.15);
  });
});

describe("speed preference store", () => {
  it("remembers a number the same way the boolean preferences are remembered", () => {
    const store = memoryStore();
    setNumberPref(SPEED_PREF_KEY, 1.35);
    expect(readNumberPref(store, SPEED_PREF_KEY, 1)).toBe(1);
    writeNumberPref(store, SPEED_PREF_KEY, 1.35);
    expect(readNumberPref(store, SPEED_PREF_KEY, 1)).toBe(1.35);
  });
});

describe("the player no longer resets to 1× on reload", () => {
  it("reads storage on mount instead of hard-coding the default", () => {
    const hook = readFileSync("src/hooks/useAudioProcessor.ts", "utf8");
    expect(hook).toContain("usePlaybackSpeed");
    expect(hook).not.toContain("SPEED_PREF_KEY, DEFAULT_PLAYBACK_SPEED))");
    // The old comment claimed a reload starts at 1x. That is now wrong.
    expect(hook).not.toContain("reload does not bring back");
  });

  it("documents the reverse in the speed module", () => {
    const source = readFileSync("src/lib/player/playback-speed.ts", "utf8");
    expect(source).toContain("SPEED_PREF_KEY");
    expect(source).toContain("deliberately reversed");
  });
});
