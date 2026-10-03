import { describe, expect, it } from "vitest";
import { runUploadExtract, type ExtractIo, type ExtractSnapshot } from "@/lib/uploads/run-extract";

function memoryIo(initial: ExtractSnapshot) {
  let row: ExtractSnapshot | null = { ...initial };
  const objects = new Map<string, Uint8Array>();
  const writes: string[] = [];
  const io: ExtractIo = {
    async load() {
      return row ? { ...row } : null;
    },
    async claim(_id, host) {
      if (!row || row.status === "ready" || row.status === "failed") return false;
      if (row.extractHost && row.extractHost !== host) return false;
      row = { ...row, status: "extracting", extractHost: host };
      return true;
    },
    async fail(_id, host, message) {
      if (!row || row.status === "ready") return;
      if (row.extractHost && row.extractHost !== host) return;
      row = { ...row, status: "failed", errorMessage: message };
    },
    async finish(_id, host) {
      if (!row || row.status !== "extracting") return;
      if (row.extractHost && row.extractHost !== host) return;
      row = { ...row, status: "ready" };
    },
    async readSource() {
      return objects.get("source") ?? null;
    },
    async writeObject(key, bytes) {
      writes.push(key);
      objects.set(key, bytes);
    },
  };
  return {
    io,
    objects,
    writes,
    row: () => row,
    set(next: ExtractSnapshot | null) {
      row = next ? { ...next } : null;
    },
  };
}

const text = "The harbour lamps burned through the fog while the tide turned. ".repeat(4);

describe("runUploadExtract", () => {
  it("writes content.txt and chapters, then a second finish is a no-op", async () => {
    const mem = memoryIo({
      status: "uploaded",
      sourcePath: "pdfs/u/source.txt",
      fileName: "book.txt",
      contentType: "text/plain",
      errorMessage: null,
      extractHost: null,
    });
    mem.objects.set("source", new TextEncoder().encode(text));

    const first = await runUploadExtract("u", "node", mem.io);
    expect(first.outcome).toBe("ready");
    if (first.outcome !== "ready") return;
    expect(first.text).toContain("harbour lamps");
    expect(mem.writes).toEqual(["pdfs/u/content.txt", "pdfs/u/chapters.json"]);
    expect(mem.row()?.status).toBe("ready");

    const second = await runUploadExtract("u", "cloudflare", mem.io);
    expect(second.outcome).toBe("skipped");
    expect(mem.writes).toHaveLength(2);
    expect(mem.row()?.status).toBe("ready");
  });

  it("does not let Cloudflare claim a row Node already owns", async () => {
    const mem = memoryIo({
      status: "extracting",
      sourcePath: "pdfs/u/source.txt",
      fileName: "book.txt",
      contentType: "text/plain",
      errorMessage: null,
      extractHost: "node",
    });
    mem.objects.set("source", new TextEncoder().encode(text));
    const result = await runUploadExtract("u", "cloudflare", mem.io);
    expect(result.outcome).toBe("skipped");
    expect(mem.writes).toHaveLength(0);
    expect(mem.row()?.status).toBe("extracting");
    expect(mem.row()?.extractHost).toBe("node");
  });

  it("does not mark a ready row failed when the text is too short for the late host", async () => {
    const mem = memoryIo({
      status: "ready",
      sourcePath: "pdfs/u/source.txt",
      fileName: "book.txt",
      contentType: "text/plain",
      errorMessage: null,
      extractHost: "node",
    });
    const result = await runUploadExtract("u", "cloudflare", mem.io);
    expect(result.outcome).toBe("skipped");
    expect(mem.row()?.status).toBe("ready");
  });
});
