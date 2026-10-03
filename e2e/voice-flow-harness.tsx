import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useUploadExtractStatus } from "@/lib/use-upload-extract-status";
import {
  startStockBook,
  JOB_CREATE_TIMEOUT_MS,
} from "@/lib/stock-job-create";

// Mirrors the voice page's Make-audiobook step with the real client modules:
// one status poller (the hook) and one bounded POST (startStockBook). The
// book exists before extraction finishes; navigation replaces history
// instead of pushing. URL params:
//   upload=<uuid>       which upload to watch (each test gets its own)
//   createTimeout=<ms>  overrides the POST timeout for the hang case
const simParams = new URLSearchParams(window.location.search);
const UPLOAD_ID =
  simParams.get("upload") || "33333333-3333-4333-8333-333333333333";
const CREATE_TIMEOUT_MS = Number(simParams.get("createTimeout") || JOB_CREATE_TIMEOUT_MS);

function VoiceFlowHarness() {
  // charCount 0 = the upload is still extracting when the page opens.
  const extract = useUploadExtractStatus(UPLOAD_ID, { charCount: 0 });
  const [suggest, setSuggest] = useState("Suggestion pending…");
  const [creating, setCreating] = useState(false);
  const [nav, setNav] = useState("");
  const [duplicate, setDuplicate] = useState(false);
  const [startError, setStartError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/pdf/upload/${UPLOAD_ID}/narrator`)
      .then(async (res) => (res.ok ? await res.json() : null))
      .then((data) => {
        if (!cancelled && data) setSuggest(data.recommendation || "suggested");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const make = async () => {
    if (creating) return;
    setCreating(true);
    setStartError("");
    try {
      const started = await startStockBook({
        pdfStoragePath: `pdfs/${UPLOAD_ID}/content.txt`,
        bookTitle: "Harness book",
        catalogVoiceId: "standard",
        voiceName: "Standard",
        charCount: extract.chars || undefined,
        timeoutMs: CREATE_TIMEOUT_MS,
      });
      setDuplicate(started.duplicate);
      // The voice page does router.replace: the player replaces this step,
      // so Back never bounces here and history does not grow.
      window.history.replaceState(
        null,
        "",
        `/dashboard/player/${started.jobId}`
      );
      setNav(`/dashboard/player/${started.jobId}`);
    } catch (error) {
      setStartError(
        error instanceof Error ? error.message : "Couldn't start. Try again."
      );
      setCreating(false);
    }
  };

  return (
    <div>
      <p data-testid="extract-status">{extract.status}</p>
      <p data-testid="extract-error">{extract.error || ""}</p>
      <p data-testid="suggest">{suggest}</p>
      <p data-testid="nav">{nav}</p>
      <p data-testid="duplicate">{duplicate ? "duplicate" : "new"}</p>
      <p data-testid="start-error">{startError}</p>
      <button
        type="button"
        data-testid="make"
        onClick={() => void make()}
        disabled={creating}
      >
        {creating ? "Making…" : "Make audiobook"}
      </button>
    </div>
  );
}

const stage = document.getElementById("stage");
if (stage) createRoot(stage).render(<VoiceFlowHarness />);
