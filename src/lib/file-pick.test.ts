import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FILE_UNREADABLE_MESSAGE,
  GOOGLE_DOCS_UPLOAD_MESSAGE,
  UNSUPPORTED_BOOK_MESSAGE,
  UNSUPPORTED_SAMPLE_MESSAGE,
  describePickReadError,
  readFileHead,
  readFileFully,
  reportPickError,
  validateBookFilePick,
  validateCloneSamplePick,
} from "@/lib/file-pick";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function wavBytes(size = 8192): Uint8Array {
  const wav = new Uint8Array(size);
  wav.set([0x52, 0x49, 0x46, 0x46], 0);
  wav.set(new TextEncoder().encode("WAVE"), 8);
  return wav;
}

describe("validateBookFilePick", () => {
  it("accepts a Drive-style PDF with no extension, empty MIME, and lazily-reported size 0", async () => {
    const file = new File(
      [new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n")],
      "book",
      { type: "" }
    );
    // Drive reports size 0 until the file is actually read.
    Object.defineProperty(file, "size", { value: 0 });
    const verdict = await validateBookFilePick(file);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.format).toBe("pdf");
  });

  it("accepts an octet-stream EPUB-looking zip with a stripped extension", async () => {
    const file = new File(
      [new TextEncoder().encode("PK\u0003\u0004META-INF/container.xml")],
      "download",
      { type: "application/octet-stream" }
    );
    const verdict = await validateBookFilePick(file);
    expect(verdict.ok).toBe(true);
  });

  it("rejects a Google Doc with the export-first message", async () => {
    const file = new File([new Uint8Array(64)], "My novel", {
      type: "application/vnd.google-apps.document",
    });
    const verdict = await validateBookFilePick(file);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.message).toBe(GOOGLE_DOCS_UPLOAD_MESSAGE);
      expect(verdict.reason).toBe("google-docs");
    }
  });

  it("rejects an image with the supported-formats message, not silence", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
    const file = new File([png], "cover.png", { type: "image/png" });
    const verdict = await validateBookFilePick(file);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.message).toBe(UNSUPPORTED_BOOK_MESSAGE);
      expect(verdict.reason).toBe("unsupported");
    }
  });

  it("turns an unreadable pick into the download-first message", async () => {
    const file = new File(
      [new TextEncoder().encode("%PDF-1.4\n1 0 obj\n")],
      "drive.pdf",
      { type: "application/pdf" }
    );
    (file as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer =
      () =>
        Promise.reject(
          new DOMException("The file could not be read", "NotReadableError")
        );
    const verdict = await validateBookFilePick(file);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.message).toBe(FILE_UNREADABLE_MESSAGE);
      expect(verdict.reason).toBe("unreadable");
    }
  });

  it("treats a read that returns zero bytes as unreadable, not as a valid empty book", async () => {
    const file = new File([new Uint8Array(0)], "book.pdf", {
      type: "application/pdf",
    });
    const verdict = await validateBookFilePick(file);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("unreadable");
  });
});

describe("validateCloneSamplePick", () => {
  it("accepts a nameless octet-stream WAV from Drive", async () => {
    const file = new File([wavBytes()], "recording", {
      type: "application/octet-stream",
    });
    const verdict = await validateCloneSamplePick(file);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.format).toBe("wav");
  });

  it("accepts an mp4 voice memo (video/mp4)", async () => {
    const mp4 = new Uint8Array(8192);
    mp4.set([0, 0, 0, 24], 0);
    mp4.set(new TextEncoder().encode("ftyp"), 4);
    const file = new File([mp4], "memo.mp4", { type: "video/mp4" });
    const verdict = await validateCloneSamplePick(file);
    expect(verdict.ok).toBe(true);
  });

  it("rejects a text file even when it is named .wav", async () => {
    const file = new File(
      [new TextEncoder().encode("just some words, not audio at all")],
      "voice.wav",
      { type: "" }
    );
    const verdict = await validateCloneSamplePick(file);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.message).toBe(UNSUPPORTED_SAMPLE_MESSAGE);
      expect(verdict.reason).toBe("unsupported");
    }
  });

  it("rejects a Google Drive video shortcut with the export-first message", async () => {
    const file = new File([new Uint8Array(64)], "clip", {
      type: "application/vnd.google-apps.video",
    });
    const verdict = await validateCloneSamplePick(file);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toBe(GOOGLE_DOCS_UPLOAD_MESSAGE);
  });

  it("accepts a Drive file that lazily reports size 0 by reading its real bytes", async () => {
    const wav = new File([wavBytes()], "voice", { type: "" });
    Object.defineProperty(wav, "size", { value: 0 });
    const verdict = await validateCloneSamplePick(wav);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.format).toBe("wav");
  });
});

describe("read helpers", () => {
  it("reads a head slice for sniffing", async () => {
    const bytes = new Uint8Array(1024 * 1024).fill(7);
    const head = await readFileHead(new File([bytes], "big.bin"), 512 * 1024);
    expect(head.byteLength).toBe(512 * 1024);
  });

  it("reads the full file without FileReader (Node) and reports progress", async () => {
    const seen: number[] = [];
    const bytes = await readFileFully(new File([new Uint8Array(16)], "f"), (f) =>
      seen.push(f)
    );
    expect(bytes.byteLength).toBe(16);
    expect(seen.at(-1)).toBe(1);
  });

  it("maps any read failure to the download-first message", () => {
    expect(describePickReadError()).toBe(FILE_UNREADABLE_MESSAGE);
  });
});

describe("reportPickError", () => {
  it("logs to the console and POSTs to /api/log", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    reportPickError("book-upload", "boom", {
      name: "book",
      size: 0,
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[book-upload] boom"),
      expect.anything()
    );
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/log",
      expect.objectContaining({ method: "POST", keepalive: true })
    );
  });

  it("never throws when the log endpoint is unreachable", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      reportPickError("clone-sample", "offline failure")
    ).not.toThrow();
  });
});
