import { describe, expect, it } from "vitest";
import { openRouterChatUrl, unwrapJsonObject } from "./openrouter-chat";

describe("openRouterChatUrl", () => {
  it("defaults to the public API", () => {
    expect(openRouterChatUrl({} as NodeJS.ProcessEnv)).toBe(
      "https://openrouter.ai/api/v1/chat/completions"
    );
  });

  it("honours an override and trims trailing slashes", () => {
    expect(
      openRouterChatUrl({ OPENROUTER_BASE_URL: "https://proxy.example/v1///" } as NodeJS.ProcessEnv)
    ).toBe("https://proxy.example/v1/chat/completions");
  });
});

describe("unwrapJsonObject", () => {
  it("parses a bare object", () => {
    expect(unwrapJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it("unwraps a fenced json block", () => {
    expect(unwrapJsonObject('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it("unwraps a fence with no language tag", () => {
    expect(unwrapJsonObject("```\n{\"a\":3}\n```")).toEqual({ a: 3 });
  });

  it("ignores prose around the object", () => {
    expect(unwrapJsonObject('Here you go: {"a":4} — hope that helps')).toEqual({ a: 4 });
  });

  it("throws when the reply holds no JSON", () => {
    expect(() => unwrapJsonObject("no json here")).toThrow();
  });
});
