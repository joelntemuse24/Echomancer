import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadFile, uploadFile } from "@/lib/storage";
import { ensureListenPrep, readListenPrepBest } from "./listen-prep-cache";

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

  it("keeps saved chunks while a retry is running and does not restart the count", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const book = "She walked to the quay and closed the ledger before dawn.\n";
    await uploadFile("pdfs/prep-running", "content.txt", Buffer.from(book, "utf8"), "text/plain");
    await uploadFile(
      "pdfs/prep-running",
      "listen-cleaned.txt",
      Buffer.from(book, "utf8"),
      "text/plain"
    );
    await uploadFile(
      "pdfs/prep-running",
      "listen-prep.json",
      Buffer.from(
        JSON.stringify({
          status: "running",
          sourceHash: (await import("node:crypto")).createHash("sha256").update(book, "utf8").digest("hex"),
          startedAt: Date.now(),
          attempts: 2,
          chunks: [{ ok: false, text: book, note: null }],
        }),
        "utf8"
      ),
      "application/json"
    );
    const fetchFn = vi.fn(async () => new Response("nope", { status: 500 }));
    const best = await readListenPrepBest("prep-running", book);
    expect(best?.text).toBe(book);
    expect(best?.settled).toBe(false);
    const during = await ensureListenPrep("prep-running", book, { fetch: fetchFn, waitMs: 0 });
    expect(during?.text).toBe(book);
    expect(fetchFn).not.toHaveBeenCalled();
    const record = JSON.parse(
      (await downloadFile("pdfs/prep-running/listen-prep.json")).toString("utf8")
    ) as { attempts?: number; chunks?: unknown[] };
    expect(record.attempts).toBe(2);
    expect(record.chunks).toHaveLength(1);
  });
});
