import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "@/proxy";

/** Next compiles the matcher with path-to-regexp; the body is plain JS regex. */
function matches(path: string): boolean {
  const pattern = config.matcher[0];
  if (!pattern) throw new Error("matcher missing");
  return new RegExp(`^${pattern}$`).test(path);
}

describe("proxy matcher", () => {
  it.each([
    "/",
    "/dashboard",
    "/dashboard/player/abc",
    "/api/jobs/1",
    "/api/tts/clone-preview/payload~sig",
    "/api/storage/audiobooks/j/full.mp3",
    "/api/storage/pdfs/u/content.txt",
    "/sign-in",
  ])("runs on %s", (path) => {
    expect(matches(path)).toBe(true);
  });

  it.each([
    "/voice-previews/standard.mp3",
    "/logo.png",
    "/robots.txt",
    "/icons/app.svg",
    "/_next/static/chunks/x.js",
    "/_next/image",
    "/favicon.ico",
  ])("skips %s", (path) => {
    expect(matches(path)).toBe(false);
  });
});

describe("signed clone preview", () => {
  it("does not set a cookie, even when the request already has a session", async () => {
    const res = await proxy(
      new NextRequest("https://echomancer.xyz/api/tts/clone-preview/payload~sig", {
        headers: { cookie: "ec_session=already-set" },
      })
    );
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
