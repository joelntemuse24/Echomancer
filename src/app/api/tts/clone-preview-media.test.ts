/**
 * The picker plays a signed, cookie-free URL. The bytes route checks the
 * signature and streams the object. It does not look up the clone.
 */

import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { uploadFile } from "@/lib/storage";
import * as storage from "@/lib/storage";
import {
  clonePreviewMediaUrl,
  signClonePreviewMediaToken,
  verifyClonePreviewMediaToken,
} from "@/lib/tts/clone-preview-media";
import { clonePreviewPathEtag } from "@/lib/tts/clone-preview-stream";
import { routeParams } from "@/test/harness";

const PATH = "previews/clones/96a74157-aaaa-4bbb-8ccc-ddddeeeeffff/0123456789abcdef0123456789abcdef.mp3";

function mp3(): Buffer {
  const bytes = Buffer.alloc(4096, 9);
  bytes[0] = 0xff;
  bytes[1] = 0xfb;
  return bytes;
}

async function put(bytes: Buffer) {
  const slash = PATH.lastIndexOf("/");
  await uploadFile(PATH.slice(0, slash), PATH.slice(slash + 1), bytes, "audio/mpeg");
}

describe("clone preview media token", () => {
  it("signs only a preview object path", () => {
    const token = signClonePreviewMediaToken(PATH);
    expect(token).toBeTruthy();
    expect(verifyClonePreviewMediaToken(token!)).toBe(PATH);
    expect(signClonePreviewMediaToken("audiobooks/job/full.mp3")).toBeNull();
    expect(signClonePreviewMediaToken("../previews/clones/a/b.mp3")).toBeNull();
    const flipped = token!.slice(0, -1) + (token!.endsWith("a") ? "b" : "a");
    expect(verifyClonePreviewMediaToken(flipped)).toBeNull();
    expect(verifyClonePreviewMediaToken(`${token}~extra`)).toBeNull();
  });

  it("builds a URL with no clone id and no query", () => {
    const url = clonePreviewMediaUrl(PATH);
    expect(url.startsWith("/api/tts/clone-preview/")).toBe(true);
    expect(url).not.toContain("96a74157");
    expect(url).not.toContain("?");
  });
});

describe("GET /api/tts/clone-preview/[token]", () => {
  it("streams the object with a public cache and no cookie", async () => {
    const bytes = mp3();
    await put(bytes);
    const download = vi.spyOn(storage, "downloadFile");
    const token = signClonePreviewMediaToken(PATH)!;
    const { GET } = await import("@/app/api/tts/clone-preview/[token]/route");
    const res = await GET(
      new NextRequest(`https://echomancer.xyz/api/tts/clone-preview/${encodeURIComponent(token)}`),
      routeParams({ token })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("cdn-cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("vercel-cdn-cache-control")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(res.headers.get("vary")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("etag")).toBe(clonePreviewPathEtag(PATH));
    expect(res.headers.get("x-echomancer-preview-resolve")).toBe("stored");
    expect(res.headers.get("server-timing")).toMatch(/open;dur=\d/);
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
    expect(download).not.toHaveBeenCalled();
  });

  it("answers 206 for a closed range and 304 for the path etag", async () => {
    const bytes = mp3();
    await put(bytes);
    const token = signClonePreviewMediaToken(PATH)!;
    const { GET } = await import("@/app/api/tts/clone-preview/[token]/route");
    const partial = await GET(
      new NextRequest(`https://echomancer.xyz/api/tts/clone-preview/${token}`, {
        headers: { range: "bytes=0-99" },
      }),
      routeParams({ token })
    );
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes 0-99/${bytes.length}`);
    expect(partial.headers.get("content-length")).toBe("100");
    expect((await partial.arrayBuffer()).byteLength).toBe(100);

    const cached = await GET(
      new NextRequest(`https://echomancer.xyz/api/tts/clone-preview/${token}`, {
        headers: { "if-none-match": clonePreviewPathEtag(PATH) },
      }),
      routeParams({ token })
    );
    expect(cached.status).toBe(304);
    expect(cached.headers.get("cache-control")).toMatch(/^public/);
    expect((await cached.arrayBuffer()).byteLength).toBe(0);
  });

  it("rejects a bad token without reading storage", async () => {
    const download = vi.spyOn(storage, "downloadFile");
    const { GET } = await import("@/app/api/tts/clone-preview/[token]/route");
    const res = await GET(
      new NextRequest("https://echomancer.xyz/api/tts/clone-preview/not-a-token"),
      routeParams({ token: "not-a-token" })
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(download).not.toHaveBeenCalled();
  });
});
