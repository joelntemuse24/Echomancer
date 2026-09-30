import { describe, expect, it } from "vitest";
import { checkPublicHttpUrl, isBlockedAddress } from "@/lib/public-url";

describe("checkPublicHttpUrl", () => {
  it("accepts a public https link and adds a scheme when one is missing", () => {
    expect(checkPublicHttpUrl("https://example.com/story?q=1")).toMatchObject({
      ok: true,
    });
    const bare = checkPublicHttpUrl("example.com/story");
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.url.href).toBe("https://example.com/story");
    const protocolRelative = checkPublicHttpUrl("//example.com/a");
    expect(protocolRelative.ok).toBe(true);
    if (protocolRelative.ok) {
      expect(protocolRelative.url.href).toBe("https://example.com/a");
    }
  });

  it("accepts a public address", () => {
    expect(checkPublicHttpUrl("https://1.1.1.1/path").ok).toBe(true);
    expect(checkPublicHttpUrl("https://8.8.8.8").ok).toBe(true);
    expect(checkPublicHttpUrl("http://[2001:4860:4860::8888]/").ok).toBe(true);
    expect(checkPublicHttpUrl("http://[::ffff:8.8.8.8]/").ok).toBe(true);
  });

  it("rejects schemes, credentials, and odd ports", () => {
    for (const raw of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "ftp://example.com/a",
      "http://user:pass@example.com/",
      "https://example.com:8443/a",
      "not a url",
      "",
    ]) {
      const result = checkPublicHttpUrl(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("INVALID_URL");
    }
  });

  it("rejects loopback, private, and metadata targets", () => {
    for (const raw of [
      "http://127.0.0.1/",
      "http://127.1/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://0/",
      "http://10.1.2.3/",
      "http://172.16.0.1/",
      "http://192.168.1.20/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:169.254.169.254]/",
      "http://[fc00::1]/",
      "http://[fe80::1]/",
      "http://[2001:db8::1]/",
      "http://localhost/",
      "http://foo.local/a",
      "https://metadata.google.internal/",
      "https://printer.internal/status",
    ]) {
      const result = checkPublicHttpUrl(raw);
      expect(result.ok, raw).toBe(false);
      if (!result.ok) expect(result.code, raw).toBe("URL_BLOCKED");
    }
  });
});

describe("isBlockedAddress", () => {
  it("treats private answers as blocked and public answers as open", () => {
    expect(isBlockedAddress("10.0.0.8")).toBe(true);
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::1")).toBe(true);
    expect(isBlockedAddress("1.1.1.1")).toBe(false);
    expect(isBlockedAddress("2001:4860:4860::8888")).toBe(false);
  });
});
