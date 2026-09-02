import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_UPLOAD_MB,
  maxUploadMb,
} from "@/lib/document-formats";

describe("maxUploadMb", () => {
  const previousMax = process.env.MAX_UPLOAD_MB;
  const previousPublic = process.env.NEXT_PUBLIC_MAX_UPLOAD_MB;

  afterEach(() => {
    if (previousMax === undefined) delete process.env.MAX_UPLOAD_MB;
    else process.env.MAX_UPLOAD_MB = previousMax;
    if (previousPublic === undefined) delete process.env.NEXT_PUBLIC_MAX_UPLOAD_MB;
    else process.env.NEXT_PUBLIC_MAX_UPLOAD_MB = previousPublic;
  });

  it("defaults to a book-real 512MB ceiling, not the old 25MB leftover", () => {
    delete process.env.MAX_UPLOAD_MB;
    delete process.env.NEXT_PUBLIC_MAX_UPLOAD_MB;
    expect(DEFAULT_MAX_UPLOAD_MB).toBe(512);
    expect(maxUploadMb()).toBe(512);
    expect(maxUploadMb()).not.toBe(25);
  });
});
