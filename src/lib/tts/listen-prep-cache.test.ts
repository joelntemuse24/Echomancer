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

  it("retries a failed chunk and then stops", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.LISTEN_PREP_RETRY_MS = "0";
    const book = "She walked to the quay and closed the ledger before dawn.\n";
    await uploadFile("pdfs/prep-retry", "content.txt", Buffer.from(book, "utf8"), "text/plain");
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return new Response("nope", { status: 500 });
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  '{"drop":[],"headings":[],"note":{"kind":"article","novelKind":null,"tone":"plain","pov":"third","dialogue":"low"}}',
              },
            },
          ],
        }),
      } as Response;
    });
    const first = await ensureListenPrep("prep-retry", book, { fetch: fetchFn });
    expect(first?.text).toContain("She walked");
    const afterFail = calls;
    expect(afterFail).toBeGreaterThan(0);
    const second = await ensureListenPrep("prep-retry", book, { fetch: fetchFn });
    expect(second?.text).toContain("She walked");
    expect(calls).toBeGreaterThan(afterFail);
    const settled = calls;
    await ensureListenPrep("prep-retry", book, { fetch: fetchFn });
    expect(calls).toBe(settled);
    delete process.env.LISTEN_PREP_RETRY_MS;
  });
});
