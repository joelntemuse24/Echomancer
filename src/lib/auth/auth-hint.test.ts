import { describe, expect, it } from "vitest";
import {
  headerAuthKind,
  parseAuthHintCookie,
  showSignedOutIntro,
} from "./auth-hint";

describe("auth hint", () => {
  it("reads only the signed-in bit", () => {
    expect(parseAuthHintCookie("ec_signed_in=1")).toBe("in");
    expect(parseAuthHintCookie("other=1; ec_signed_in=0")).toBe("out");
    expect(parseAuthHintCookie("ec_session=secret")).toBe("unknown");
    expect(parseAuthHintCookie(null)).toBe("unknown");
  });

  it("shows Sign in and the home intro for a signed-out visitor without the viewer", () => {
    expect(headerAuthKind("out", null)).toBe("sign-in");
    expect(showSignedOutIntro("out", null)).toBe(true);
  });

  it("does not flash Sign in or the intro at a signed-in visitor", () => {
    expect(headerAuthKind("in", null)).toBe("account");
    expect(headerAuthKind("unknown", null)).toBe("reserved");
    expect(showSignedOutIntro("in", null)).toBe(false);
    expect(showSignedOutIntro("unknown", null)).toBe(false);
    expect(showSignedOutIntro("out", true)).toBe(false);
    expect(headerAuthKind("out", { signedIn: true })).toBe("account");
  });

  it("follows a loaded identity", () => {
    expect(showSignedOutIntro("in", false)).toBe(true);
    expect(headerAuthKind("in", { signedIn: false })).toBe("sign-in");
  });
});
