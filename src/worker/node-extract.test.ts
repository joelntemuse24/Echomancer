import { describe, expect, it } from "vitest";
import { extractChildExecArgv } from "@/worker/node-extract";

describe("extractChildExecArgv", () => {
  it("adds the tsx loader when the parent was not started with one", () => {
    expect(extractChildExecArgv([])).toEqual(["--import", "tsx"]);
  });

  it("keeps an existing tsx loader and drops the inspector", () => {
    expect(
      extractChildExecArgv(["--import", "tsx", "--inspect=9229"])
    ).toEqual(["--import", "tsx"]);
  });
});
