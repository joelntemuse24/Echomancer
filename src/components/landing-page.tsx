"use client";

import { useState, useRef } from "react";
import { Upload, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AuthControls } from "@/components/auth-controls";
import { Wordmark } from "@/components/wordmark";
import type { ViewerIdentity } from "@/lib/auth/identity";
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

export function LandingPage({ identity }: { identity: ViewerIdentity }) {
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
  const canSubmitDocument = Boolean(bookFile);
  const canSubmitPaste =
    pasteKind === "url"
      ? pasteUrl.trim().length > 0 && urlCheck.ok
      : pasteLen >= PASTE_MIN_CHARS && pasteLen <= PASTE_MAX_CHARS;
  const canSubmit =
    mode === "document" ? canSubmitDocument : canSubmitPaste;

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
    <div className="min-h-screen bg-background text-foreground font-serif flex flex-col">
      <nav className="px-8 py-8 flex justify-end items-center font-sans">
        <AuthControls identity={identity} callbackUrl="/" />
      </nav>

      <section className="px-8 pb-28 pt-28 sm:pt-36">
        <div className="mx-auto max-w-lg space-y-16 text-center">
          <div>
            <h1>
              <Wordmark size="hero" />
            </h1>
          </div>

          <div className="space-y-8 font-sans">
            <div className="flex justify-center gap-10 text-sm">
              <button
                type="button"
                onClick={() => setMode("document")}
                className={`tap pb-1 transition-colors ${
                  mode === "document"
                    ? "border-b border-copper text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {LANDING.uploadTab}
              </button>
              <button
                type="button"
                onClick={() => setMode("paste")}
                className={`tap pb-1 transition-colors ${
                  mode === "paste"
                    ? "border-b border-copper text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {LANDING.pasteTab}
              </button>
            </div>

            {mode === "document" ? (
              <div
                onDrop={handleBookDrop}
                onDragOver={(e) => e.preventDefault()}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                className={`group relative cursor-pointer border border-border/40 p-20 transition-colors hover:border-border ${
                  isDraggingBook ? "border-border bg-accent/30" : ""
                }`}
              >
                <input
                  type="file"
                  accept={SUPPORTED_DOCUMENT_ACCEPT}
                  aria-label="Choose a book"
                  onChange={(e) => handleBookFile(e.target.files?.[0])}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
                <div className="text-center space-y-3">
                  <Upload
                    aria-hidden="true"
                    className="w-5 h-5 mx-auto text-muted-foreground group-hover:text-foreground transition-colors"
                  />
                  <div className="text-sm">
                    {bookFile ? bookFile.name : "Your book"}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-left space-y-3">
                <div className="flex gap-6 text-xs">
                  <button
                    type="button"
                    onClick={() => setPasteKind("text")}
                    aria-pressed={pasteKind === "text"}
                    className={`tap pb-1 transition-colors ${
                      pasteKind === "text"
                        ? "border-b border-copper text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {LANDING.pasteTextOption}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPasteKind("url")}
                    aria-pressed={pasteKind === "url"}
                    className={`tap pb-1 transition-colors ${
                      pasteKind === "url"
                        ? "border-b border-copper text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {LANDING.pasteUrlOption}
                  </button>
                </div>
                <input
                  value={pasteTitle}
                  onChange={(e) => setPasteTitle(e.target.value)}
                  placeholder="Title"
                  maxLength={200}
                  className="w-full h-11 px-3 border border-border/40 bg-transparent text-sm outline-none focus:border-border"
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
                      className="w-full h-11 px-3 border border-border/40 bg-transparent text-sm outline-none focus:border-border"
                      aria-label="Link"
                    />
                    {pasteUrl.trim() && !urlCheck.ok ? (
                      <div className="text-[11px] text-muted-foreground">
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
                      rows={10}
                      className="w-full min-h-[220px] px-3 py-2 border border-border/40 bg-transparent text-sm leading-relaxed resize-y outline-none focus:border-border"
                      aria-label="Text"
                    />
                    {pasteLen > 0 ? (
                      <div className="flex justify-between gap-3 text-[11px] text-muted-foreground">
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
              disabled={isUploading || !canSubmit}
              className="inline-flex min-h-11 min-w-24 items-center justify-center gap-2 rounded-full px-6 py-2.5 text-sm bg-foreground text-background hover:bg-foreground/85 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {isUploading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : null}
              {ctaLabel}
            </button>
          </div>
        </div>
      </section>

      <footer className="mt-auto px-8 py-12 font-sans">
        <div className="flex justify-end">
          <Link
            href="/privacy"
            className="text-xs text-foreground/35 transition-colors hover:text-foreground/70"
          >
            Privacy
          </Link>
        </div>
      </footer>
    </div>
  );
}
