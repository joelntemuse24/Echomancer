import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readClientSearch,
  resetClientSearchForTests,
  subscribeClientSearch,
} from "./client-search";

afterEach(() => {
  resetClientSearchForTests();
  vi.unstubAllGlobals();
});

describe("client search subscription", () => {
  it("hears replaceState, which the clone tab uses", () => {
    let search = "";
    vi.stubGlobal("history", {
      pushState() {},
      replaceState() {
        search = "?path=clone";
      },
    });
    vi.stubGlobal("window", {
      location: {
        get search() {
          return search;
        },
      },
      addEventListener() {},
    });

    const seen: string[] = [];
    const stop = subscribeClientSearch(() => {
      seen.push(readClientSearch());
    });

    history.replaceState(null, "", "/dashboard/voice?path=clone");

    expect(seen).toEqual(["?path=clone"]);
    expect(new URLSearchParams(seen[0]).get("path")).toBe("clone");
    stop();
  });

  it("hears popstate for Back", () => {
    let search = "?path=clone";
    let onPop: (() => void) | null = null;
    vi.stubGlobal("history", {
      pushState() {},
      replaceState() {},
    });
    vi.stubGlobal("window", {
      location: {
        get search() {
          return search;
        },
      },
      addEventListener(type: string, listener: () => void) {
        if (type === "popstate") onPop = listener;
      },
    });

    const seen: string[] = [];
    subscribeClientSearch(() => {
      seen.push(readClientSearch());
    });
    search = "";
    onPop?.();

    expect(seen).toEqual([""]);
  });
});
