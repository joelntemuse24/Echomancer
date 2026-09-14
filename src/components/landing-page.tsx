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
import { networkOrParseError, uploadBookFile } from "@/lib/upload-client";
import { LANDING } from "@/lib/ux-copy";

type IntakeMode = "document" | "paste";

const PASTE_MIN_CHARS = 50;
const PASTE_MAX_CHARS = 500_000;

export function LandingPage({ identity }: { identity: ViewerIdentity }) {
  const router = useRouter();
  const [mode, setMode] = useState<IntakeMode>("document");
  const [bookFile, setBookFile] = useState<File | null>(null);
  const [pastedText, setPastedText] = useState("");
  const [pasteTitle, setPasteTitle] = useState("");
  const [isDraggingBook, setIsDraggingBook] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const dragCounter = useRef(0);

  const pasteLen = pastedText.trim().length;
  const canSubmitDocument = Boolean(bookFile);
  const canSubmitPaste =
    pasteLen >= PASTE_MIN_CHARS && pasteLen <= PASTE_MAX_CHARS;
  const canSubmit =
    mode === "document" ? canSubmitDocument : canSubmitPaste;

  const handleBookFile = (file: File | undefined) => {
    if (!file) return;
    if (!isSupportedDocument(file)) {
      toast.error(
        "Unsupported format. Use EPUB, PDF, DOCX, TXT, RTF, or MOBI."
      );
      return;
    }
    if (file.size > maxUploadBytes()) {
      toast.error(
        `File is too large. Please use a document under ${maxUploadMb()} MB.`
      );
      return;
    }
    if (file.size === 0) {
      toast.error("That file looks empty. Please choose another document.");
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
      toast.error("Please select a document first");
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
    const text = pastedText.trim();
    if (text.length < PASTE_MIN_CHARS) {
      toast.error(`Please paste at least ${PASTE_MIN_CHARS} characters.`);
      return;
    }
    if (text.length > PASTE_MAX_CHARS) {
      toast.error(
        `Text is too long (max ${PASTE_MAX_CHARS.toLocaleString()} characters).`
      );
      return;
    }
    setIsUploading(true);
    try {
      const res = await fetch("/api/text/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          title: pasteTitle.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't save that text");
      goToVoice(data);
    } catch (error: unknown) {
      toast.error(
        error instanceof Error ? error.message : "Couldn't save that text"
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
      ? "Saving text…"
      : "Uploading…"
    : LANDING.createCta;

  return (
    <div className="min-h-screen bg-background text-foreground font-serif flex flex-col">
      <nav className="px-8 py-8 flex justify-end items-center font-sans">
        <AuthControls identity={identity} callbackUrl="/" />
      </nav>

      <section className="px-8 pt-20 pb-24 sm:pt-28">
        <div className="max-w-lg mx-auto text-center space-y-12">
          <div>
            <h1>
              <Wordmark size="hero" />
            </h1>
          </div>

          <div className="space-y-6 font-sans">
            <div className="flex justify-center gap-8 text-sm">
              <button
                type="button"
                onClick={() => setMode("document")}
                className={`pb-1 transition-colors ${
                  mode === "document"
                    ? "text-foreground border-b border-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {LANDING.uploadTab}
              </button>
              <button
                type="button"
                onClick={() => setMode("paste")}
                className={`pb-1 transition-colors ${
                  mode === "paste"
                    ? "text-foreground border-b border-foreground"
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
                className={`relative border border-border/40 p-14 transition-colors cursor-pointer group hover:border-border ${
                  isDraggingBook ? "border-border bg-accent/30" : ""
                }`}
              >
                <input
                  type="file"
                  accept={SUPPORTED_DOCUMENT_ACCEPT}
                  aria-label="Choose a book to convert"
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
                <input
                  value={pasteTitle}
                  onChange={(e) => setPasteTitle(e.target.value)}
                  placeholder="Title (optional)"
                  maxLength={200}
                  className="w-full h-11 px-3 border border-border/40 bg-transparent text-sm outline-none focus:border-border"
                  aria-label="Title for pasted text"
                />
                <textarea
                  value={pastedText}
                  onChange={(e) => setPastedText(e.target.value)}
                  placeholder="Paste the text to narrate…"
                  rows={10}
                  className="w-full min-h-[220px] px-3 py-2 border border-border/40 bg-transparent text-sm leading-relaxed resize-y outline-none focus:border-border"
                  aria-label="Text to narrate"
                />
                <div className="flex justify-between gap-3 text-[11px] text-muted-foreground">
                  <span>
                    {pasteLen.toLocaleString()} /{" "}
                    {PASTE_MAX_CHARS.toLocaleString()} characters
                  </span>
                  {pasteLen > 0 && pasteLen < PASTE_MIN_CHARS ? (
                    <span>Need at least {PASTE_MIN_CHARS}</span>
                  ) : null}
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={handleSubmit}
              disabled={isUploading || !canSubmit}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm bg-foreground text-background hover:bg-foreground/85 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
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
        <div className="max-w-lg mx-auto flex justify-between items-center text-xs text-muted-foreground">
          <div className="flex items-center gap-6">
            <Link
              href="/dashboard/resources"
              className="hover:text-foreground transition-colors"
            >
              {LANDING.howItWorks}
            </Link>
          </div>
          <Link href="/privacy" className="hover:text-foreground transition-colors">
            Privacy
          </Link>
        </div>
      </footer>
    </div>
  );
}
