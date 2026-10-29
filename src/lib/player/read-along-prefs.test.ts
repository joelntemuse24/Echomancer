import { describe, expect, it } from "vitest";
import {
  FOLLOW_PREF_KEY,
  boolPrefServerSnapshot,
  boolPrefSnapshot,
  readBoolPref,
  setBoolPref,
  subscribePrefs,
  writeBoolPref,
} from "./read-along-prefs";

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

describe("read-along preferences", () => {
  it("reads the stored flag, and the fallback for anything else", () => {
    const store = memoryStore({ on: "1", off: "0", junk: "yes" });
    expect(readBoolPref(store, "on", false)).toBe(true);
    expect(readBoolPref(store, "off", true)).toBe(false);
    expect(readBoolPref(store, "junk", true)).toBe(true);
    expect(readBoolPref(store, "missing", true)).toBe(true);
  });

  it("treats a missing or refusing store as absent instead of throwing", () => {
    const refuses = {
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => {
        throw new Error("private mode");
      },
    };
    expect(readBoolPref(null, "k", true)).toBe(true);
    expect(readBoolPref(refuses, "k", false)).toBe(false);
    expect(() => writeBoolPref(refuses, "k", true)).not.toThrow();
    expect(() => writeBoolPref(null, "k", true)).not.toThrow();
  });

  it("notifies watchers and keeps the value even when storage refuses it", () => {
    let notified = 0;
    const unsubscribe = subscribePrefs(() => {
      notified += 1;
    });
    setBoolPref(FOLLOW_PREF_KEY, false);
    expect(notified).toBe(1);
    expect(boolPrefSnapshot(FOLLOW_PREF_KEY, true)).toBe(false);
    setBoolPref(FOLLOW_PREF_KEY, true);
    expect(notified).toBe(2);
    expect(boolPrefSnapshot(FOLLOW_PREF_KEY, true)).toBe(true);
    unsubscribe();
    setBoolPref(FOLLOW_PREF_KEY, false);
    expect(notified).toBe(2);
  });

  it("renders the fallback on the server, so markup never disagrees with storage", () => {
    setBoolPref(FOLLOW_PREF_KEY, false);
    expect(boolPrefServerSnapshot(true)).toBe(true);
  });
});
