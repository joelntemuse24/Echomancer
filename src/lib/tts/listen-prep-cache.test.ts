import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadFile } from "@/lib/storage";
import { ensureListenPrep } from "./listen-prep-cache";

describe("ensureListenPrep", () => {
  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  it("stores an unchanged book and does not clean it again", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const book = "She walked to the quay and closed the ledger before dawn.\n";
    await uploadFile("pdfs/prep-once", "content.txt", Buffer.from(book, "utf8"), "text/plain");
    const fetchFn = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  '{"drop":[],"headings":[],"note":{"kind":"novel","novelKind":"literary","tone":"quiet","pov":"third","dialogue":"low"}}',
              },
            },
          ],
        }),
      } as Response;
    });
    const first = await ensureListenPrep("prep-once", book, { fetch: fetchFn });
    const second = await ensureListenPrep("prep-once", book, { fetch: fetchFn });
    expect(first?.text).toBe(book);
    expect(second?.text).toBe(book);
    expect(first?.narrator?.catalogVoiceId).toBe("standard");
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
