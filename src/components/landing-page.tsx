"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  SUPPORTED_DOCUMENT_ACCEPT,
  isSupportedDocument,
  maxUploadBytes,
  maxUploadMb,
} from "@/lib/document-formats";
import { PASTE_MAX_CHARS, PASTE_MIN_CHARS } from "@/lib/paste-limits";
import { checkPublicHttpUrl } from "@/lib/public-url";
import { networkOrParseError, uploadBookFile } from "@/lib/upload-client";
import { LANDING } from "@/lib/ux-copy";

type IntakeMode = "document" | "paste";
type PasteKind = "text" | "url";

const tabClass = (active: boolean) =>
  `inline-flex min-h-11 items-center px-1 text-sm transition-colors ${
    active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
  }`;

const fieldClass =
  "w-full border-0 border-b border-foreground/20 bg-transparent py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-foreground/60";

export function LandingPage() {
  const router = useRouter();
  const [mode, setMode] = useState<IntakeMode>("document");
  const [bookFile, setBookFile] = useState<File | null>(null);
  const [pasteKind, setPasteKind] = useState<PasteKind>("text");
  const [pastedText, setPastedText] = useState("");
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteUrl, setPasteUrl] = useState("");
  const [isDraggingBook, setIsDraggingBook] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const dragCounter = useRef(0);

  const pasteLen = pastedText.trim().length;
  const urlCheck = checkPublicHttpUrl(pasteUrl);

  const handleBookFile = (file: File | undefined) => {
    if (!file) return;
    if (!isSupportedDocument(file)) {
      toast.error("Use EPUB, PDF, DOCX, TXT, RTF, or MOBI.");
      return;
    }
    if (file.size > maxUploadBytes()) {
      toast.error(
        `Too large. Use a file under ${maxUploadMb()} MB.`
      );
      return;
    }
    if (file.size === 0) {
      toast.error("That file is empty. Choose another.");
      return;
    }
    setBookFile(file);
    setMode("document");
  };

  const handleBookDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDraggingBook(false);
    handleBookFile(e.dataTransfer.files[0]);
  };

  const goToVoice = (data: {
    storagePath?: string;
    fileName?: string;
    charCount?: number;
    chars?: number;
    uploadId?: string;
  }) => {
    const chars = data.charCount ?? data.chars ?? 0;
    const q = new URLSearchParams({
      pdfPath: data.storagePath || "",
      pdfName: data.fileName || "Untitled",
    });
    if (chars) q.set("charCount", String(chars));
    if (data.uploadId) q.set("uploadId", data.uploadId);
    router.push(`/dashboard/voice?${q.toString()}`);
  };

  const handleSubmitDocument = async () => {
    if (!bookFile) {
      toast.error("Choose a book first.");
      return;
    }
    setIsUploading(true);
    try {
      const data = await uploadBookFile(bookFile);
      goToVoice(data);
    } catch (error: unknown) {
      toast.error(networkOrParseError(error));
    } finally {
      setIsUploading(false);
    }
  };

  const handleSubmitPaste = async () => {
    const title = pasteTitle.trim() || undefined;
    let payload: { text?: string; url?: string; title?: string };

    if (pasteKind === "url") {
      const checked = checkPublicHttpUrl(pasteUrl);
      if (!checked.ok) {
        toast.error(checked.message);
        return;
      }
      payload = { url: checked.url.href, title };
    } else {
      const text = pastedText.trim();
      if (text.length < PASTE_MIN_CHARS) {
        toast.error(`Paste at least ${PASTE_MIN_CHARS} characters.`);
        return;
      }
      if (text.length > PASTE_MAX_CHARS) {
        toast.error(
          `Too long. Maximum is ${PASTE_MAX_CHARS.toLocaleString()} characters.`
        );
        return;
      }
      payload = { text, title };
    }

    setIsUploading(true);
    try {
      const res = await fetch("/api/text/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't save that. Try again.");
      goToVoice(data);
    } catch (error: unknown) {
      toast.error(
        error instanceof Error ? error.message : "Couldn't save that. Try again."
      );
    } finally {
      setIsUploading(false);
    }
  };

  const handleSubmit = async () => {
    if (mode === "paste") await handleSubmitPaste();
    else await handleSubmitDocument();
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current += 1;
    setIsDraggingBook(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current -= 1;
    if (dragCounter.current === 0) {
      setIsDraggingBook(false);
    }
  };

  const ctaLabel = isUploading
    ? mode === "paste"
      ? pasteKind === "url"
        ? "Reading…"
        : "Saving…"
      : "Uploading…"
    : LANDING.createCta;

  return (
    <div className="mx-auto w-full max-w-md text-center">
      <h1 className="font-serif text-5xl font-light tracking-tight text-foreground sm:text-6xl">
        {LANDING.headline}
      </h1>

      <div className="mt-16 flex justify-center gap-8">
        <button
          type="button"
          onClick={() => setMode("document")}
          className={tabClass(mode === "document")}
        >
          {LANDING.uploadTab}
        </button>
        <button
          type="button"
          onClick={() => setMode("paste")}
          className={tabClass(mode === "paste")}
        >
          {LANDING.pasteTab}
        </button>
      </div>

      {mode === "document" ? (
        <label
          onDrop={handleBookDrop}
          onDragOver={(e) => e.preventDefault()}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          className="relative mx-auto mt-10 block w-full cursor-pointer pb-2 text-left"
        >
          <input
            type="file"
            accept={SUPPORTED_DOCUMENT_ACCEPT}
            aria-label="Choose a book"
            onChange={(e) => handleBookFile(e.target.files?.[0])}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
          <span
            className={`block text-sm ${
              bookFile ? "text-foreground" : "text-muted-foreground"
            }`}
          >
            {bookFile ? bookFile.name : LANDING.uploadPrompt}
          </span>
          <span
            className={`mt-4 block h-px ${
              isDraggingBook ? "bg-foreground" : "bg-foreground/25"
            }`}
          />
        </label>
      ) : (
        <div className="mx-auto mt-10 space-y-4 text-left">
          <div className="flex gap-6">
            <button
              type="button"
              onClick={() => setPasteKind("text")}
              aria-pressed={pasteKind === "text"}
              className={tabClass(pasteKind === "text")}
            >
              {LANDING.pasteTextOption}
            </button>
            <button
              type="button"
              onClick={() => setPasteKind("url")}
              aria-pressed={pasteKind === "url"}
              className={tabClass(pasteKind === "url")}
            >
              {LANDING.pasteUrlOption}
            </button>
          </div>
          <input
            value={pasteTitle}
            onChange={(e) => setPasteTitle(e.target.value)}
            placeholder="Title"
            maxLength={200}
            className={fieldClass}
            aria-label="Title"
          />
          {pasteKind === "url" ? (
            <>
              <input
                value={pasteUrl}
                onChange={(e) => setPasteUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleSubmit();
                  }
                }}
                placeholder={LANDING.pasteUrlPlaceholder}
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className={fieldClass}
                aria-label="Link"
              />
              {pasteUrl.trim() && !urlCheck.ok ? (
                <div className="text-xs text-muted-foreground">
                  {urlCheck.message}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <textarea
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                placeholder="Paste text"
                rows={8}
                className={`${fieldClass} min-h-[180px] resize-y leading-relaxed`}
                aria-label="Text"
              />
              {pasteLen > 0 ? (
                <div className="flex justify-between gap-3 text-xs text-muted-foreground">
                  <span>
                    {pasteLen.toLocaleString()} /{" "}
                    {PASTE_MAX_CHARS.toLocaleString()}
                  </span>
                  {pasteLen < PASTE_MIN_CHARS ? (
                    <span>At least {PASTE_MIN_CHARS}</span>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={isUploading}
        className="mt-14 inline-flex min-h-11 items-center text-sm text-foreground underline decoration-foreground/70 underline-offset-[7px] transition-opacity hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-30"
      >
        {ctaLabel}
      </button>
    </div>
  );
}
