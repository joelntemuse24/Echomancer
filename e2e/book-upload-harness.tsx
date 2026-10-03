import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SUPPORTED_DOCUMENT_ACCEPT } from "@/lib/document-formats";
import { SUPPORTED_CLONE_SAMPLE_ACCEPT } from "@/lib/clone-sample-formats";
import {
  uploadBookFile,
  type UploadPhase,
} from "@/lib/upload-client";
import {
  validateBookFilePick,
  validateCloneSamplePick,
  type FilePickResult,
} from "@/lib/file-pick";

// ── Android / Drive simulation, installed before any component runs ──────
// The flags come from the URL so a Playwright test can pick the failure it
// wants to reproduce. Real browser APIs are patched, not the app code.
//   failblob=1   — Blob.arrayBuffer() rejects (the pick-time head read
//                  fails: NotReadableError on a content:// grant)
//   failreader=1 — FileReader errors (the pick succeeded, but the full
//                  read at upload time fails — the read-after-await case)
//   slow=N       — both reads take N ms (lazy Drive download)
const simParams = new URLSearchParams(window.location.search);
const failBlob = simParams.get("failblob") === "1";
const failReader = simParams.get("failreader") === "1";
const slowReadMs = Number(simParams.get("slow") || 0);

if (failBlob || failReader || slowReadMs > 0) {
  const notReadable = () =>
    Promise.reject(
      new DOMException("The file could not be read", "NotReadableError")
    );
  if (failBlob || slowReadMs > 0) {
    const blobArrayBuffer = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
      if (failBlob) return notReadable();
      if (slowReadMs > 0) {
        return new Promise((resolve, reject) => {
          setTimeout(() => blobArrayBuffer.call(this).then(resolve, reject), slowReadMs);
        });
      }
      return blobArrayBuffer.call(this);
    };
  }
  if (failReader || slowReadMs > 0) {
    const fileReaderRead = FileReader.prototype.readAsArrayBuffer;
    FileReader.prototype.readAsArrayBuffer = function (
      this: FileReader,
      blob: Blob
    ) {
      if (failReader) {
        setTimeout(() => this.dispatchEvent(new ProgressEvent("error")), 0);
        return;
      }
      setTimeout(() => {
        try {
          fileReaderRead.call(this, blob);
        } catch {
          this.dispatchEvent(new ProgressEvent("error"));
        }
      }, slowReadMs);
    };
  }
}

function Harness() {
  const [bookFile, setBookFile] = useState<File | null>(null);
  const [bookReading, setBookReading] = useState(false);
  const [bookMessage, setBookMessage] = useState("");
  const [pickCount, setPickCount] = useState(0);
  const [ctaLabel, setCtaLabel] = useState("Create audiobook");
  const [phaseLog, setPhaseLog] = useState("");
  const [uploading, setUploading] = useState(false);

  const [cloneAccepted, setCloneAccepted] = useState("");
  const [cloneMessage, setCloneMessage] = useState("");
  const [clonePickCount, setClonePickCount] = useState(0);

  const logPhase = (entry: string) =>
    setPhaseLog((prev) => (prev ? `${prev},${entry}` : entry));

  const onBookPick = async (file: File | undefined) => {
    setPickCount((n) => n + 1);
    setBookMessage("");
    if (!file) return;
    setBookReading(true);
    try {
      const verdict: FilePickResult = await validateBookFilePick(file);
      if (!verdict.ok) {
        setBookMessage(verdict.message);
        setBookFile(null);
        return;
      }
      setBookFile(file);
    } catch (error) {
      setBookMessage(error instanceof Error ? error.message : "Pick failed.");
    } finally {
      setBookReading(false);
    }
  };

  const submit = async () => {
    if (!bookFile || uploading) return;
    setUploading(true);
    let lastPhase: UploadPhase | null = null;
    try {
      const data = await uploadBookFile(bookFile, {
        onPhase: (phase) => {
          lastPhase = phase;
          setCtaLabel(phase === "reading" ? "Reading…" : "Uploading…");
          logPhase(phase === "reading" ? "reading" : "uploading");
        },
        onProgress: (fraction) => {
          const pct = Math.max(1, Math.round(fraction * 100));
          if (lastPhase === "uploading") {
            setCtaLabel(`Uploading… ${pct}%`);
            if (pct === 100) logPhase("uploading:100");
          }
        },
      });
      logPhase(`done:${data.uploadId ? "ok" : "ok"}`);
      setCtaLabel("Done");
    } catch (error) {
      setBookMessage(error instanceof Error ? error.message : "Upload failed.");
      setCtaLabel("Create audiobook");
    } finally {
      setUploading(false);
    }
  };

  const onClonePick = async (file: File | undefined) => {
    setClonePickCount((n) => n + 1);
    setCloneMessage("");
    setCloneAccepted("");
    if (!file) return;
    try {
      const verdict = await validateCloneSamplePick(file);
      if (!verdict.ok) {
        setCloneMessage(verdict.message);
        return;
      }
      setCloneAccepted(`${file.name} · ${verdict.format}`);
    } catch (error) {
      setCloneMessage(error instanceof Error ? error.message : "Pick failed.");
    }
  };

  return (
    <div>
      <p data-testid="pick-count">{pickCount}</p>
      <p data-testid="pick-state">
        {bookReading ? "Reading…" : bookFile ? bookFile.name : "Your book"}
      </p>
      <p data-testid="pick-message">{bookMessage}</p>
      <p data-testid="phase-log">{phaseLog}</p>
      <input
        type="file"
        aria-label="Choose a book"
        accept={SUPPORTED_DOCUMENT_ACCEPT}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          void onBookPick(file);
        }}
        style={{ display: "block", margin: "12px auto" }}
      />
      <button
        type="button"
        data-testid="submit"
        onClick={() => void submit()}
        disabled={!bookFile || uploading}
      >
        <span data-testid="cta-label">{ctaLabel}</span>
      </button>

      <hr style={{ margin: "32px 0", border: 0, borderTop: "1px solid #333" }} />
      <p data-testid="clone-pick-count">{clonePickCount}</p>
      <p data-testid="clone-pick-state">
        {cloneAccepted || "No sample"}
      </p>
      <p data-testid="clone-pick-message">{cloneMessage}</p>
      <input
        type="file"
        aria-label="Choose a sample"
        accept={SUPPORTED_CLONE_SAMPLE_ACCEPT}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          void onClonePick(file);
        }}
        style={{ display: "block", margin: "12px auto" }}
      />
    </div>
  );
}

const stage = document.getElementById("stage");
if (stage) createRoot(stage).render(<Harness />);
