import { describe, expect, it } from "vitest";
import { presignPutObjectInput } from "@/lib/r2-storage";

describe("presignPutObjectInput", () => {
  it("signs Content-Type only — never ContentLength, which 400s browser PUTs", () => {
    const input = presignPutObjectInput("pdfs/abc/source.pdf", "application/pdf");
    expect(input.ContentType).toBe("application/pdf");
    expect(input.Key).toBe("pdfs/abc/source.pdf");
    expect(input).not.toHaveProperty("ContentLength");
  });
});
