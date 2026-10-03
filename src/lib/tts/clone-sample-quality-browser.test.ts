import { describe, expect, it } from "vitest";
import { prepareCloneSampleFile } from "@/lib/tts/clone-sample-quality-browser";

describe("prepareCloneSampleFile", () => {
  it("reports an undecoded file so the caller can block a raw video container", async () => {
    // In the Node test environment there is no AudioContext, so the
    // decode cannot run — the same flag a browser sets when a .mov's
    // audio track can't be decoded.
    const file = new File([new Uint8Array(8192)], "memo.mov", {
      type: "video/quicktime",
    });
    const prepared = await prepareCloneSampleFile(file);
    expect(prepared.decoded).toBe(false);
    expect(prepared.file).toBe(file);
    expect(prepared.report).toBeNull();
  });
});
