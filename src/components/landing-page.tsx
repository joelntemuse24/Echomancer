"use client";

import { useState, useRef } from "react";
import { motion } from "motion/react";
import { Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  DrawablyButton,
  DrawablyCard,
  DrawablyHighlight,
  DrawablyInput,
  DrawablyTabs,
  DrawablyTextarea,
} from "drawably/react";
import { AuthControls } from "@/components/auth-controls";
import type { ViewerIdentity } from "@/lib/auth/identity";
import {
  SUPPORTED_DOCUMENT_ACCEPT,
  isSupportedDocument,
  maxUploadBytes,
  maxUploadMb,
} from "@/lib/document-formats";
import { sketchSeed } from "@/lib/sketch-seed";
import {
  networkOrParseError,
  uploadBookFile,
  type UploadPhase,
} from "@/lib/upload-client";
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
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("uploading");
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
  }) => {
    const chars = data.charCount ?? data.chars ?? 0;
    const q = new URLSearchParams({
      pdfPath: data.storagePath || "",
      pdfName: data.fileName || "Untitled",
    });
    if (chars) q.set("charCount", String(chars));
    router.push(`/dashboard/voice?${q.toString()}`);
  };

  const handleSubmitDocument = async () => {
    if (!bookFile) {
      toast.error("Please select a document first");
      return;
    }
    setUploadPhase("uploading");
    setIsUploading(true);
    try {
      const data = await uploadBookFile(bookFile, setUploadPhase);
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
      : uploadPhase === "reading"
        ? "Reading document…"
        : "Uploading…"
    : LANDING.createCta;

  return (
    <div className="min-h-screen bg-background text-foreground font-serif">
      <motion.nav
        className="fixed top-0 left-0 right-0 z-50 px-8 py-6 flex justify-between items-center bg-background/80 backdrop-blur-sm"
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
      >
        <div className="text-sm tracking-[0.2em] uppercase font-serif">
          Echomancer
        </div>
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <DrawablyButton
            type="button"
            seed={sketchSeed("landing-library")}
            onClick={() => router.push("/dashboard/queue")}
          >
            {LANDING.libraryCta}
          </DrawablyButton>
          <AuthControls identity={identity} callbackUrl="/" />
        </div>
      </motion.nav>

      <section className="relative min-h-screen flex items-center justify-center px-8 pt-24">
        <div className="max-w-4xl mx-auto text-center space-y-10">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, delay: 0.2 }}
          >
            <h1
              className="text-5xl sm:text-7xl md:text-9xl tracking-tight mb-6"
              style={{
                fontWeight: 300,
                letterSpacing: "-0.02em",
              }}
            >
              Echomancer
            </h1>
            <p className="text-xl md:text-2xl text-muted-foreground max-w-2xl mx-auto leading-relaxed font-serif">
              Upload a book or paste text.{" "}
              <DrawablyHighlight seed={sketchSeed("landing-fish")}>
                Fish Audio
              </DrawablyHighlight>{" "}
              turns it into an audiobook.
            </p>
          </motion.div>

          <motion.div
            className="max-w-md mx-auto space-y-6"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, delay: 0.5 }}
          >
            <DrawablyTabs
              active={mode === "document" ? 0 : 1}
              seed={sketchSeed("landing-tabs")}
              className="ec-tabs"
            >
              <button
                type="button"
                role="tab"
                onClick={() => setMode("document")}
              >
                {LANDING.uploadTab}
              </button>
              <button type="button" role="tab" onClick={() => setMode("paste")}>
                {LANDING.pasteTab}
              </button>
            </DrawablyTabs>

            {mode === "document" ? (
              <DrawablyCard
                seed={sketchSeed("landing-dropzone")}
                onDrop={handleBookDrop}
                onDragOver={(e) => e.preventDefault()}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                className={`ec-dropzone relative cursor-pointer group ${
                  isDraggingBook ? "bg-accent/40" : ""
                }`}
              >
                <input
                  type="file"
                  accept={SUPPORTED_DOCUMENT_ACCEPT}
                  aria-label="Choose a book to convert"
                  onChange={(e) => handleBookFile(e.target.files?.[0])}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
                <div className="text-center space-y-4">
                  <Upload
                    aria-hidden="true"
                    className="w-8 h-8 mx-auto text-muted-foreground group-hover:text-foreground transition-colors"
                  />
                  <div>
                    <div className="text-sm uppercase tracking-wider mb-2 font-serif">
                      {bookFile ? bookFile.name : "Your book"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      EPUB or TXT preferred · PDF, DOCX, RTF, MOBI · up to{" "}
                      {maxUploadMb()} MB
                    </div>
                  </div>
                </div>
              </DrawablyCard>
            ) : (
              <DrawablyCard
                seed={sketchSeed("landing-paste")}
                className="text-left space-y-3"
              >
                <DrawablyInput
                  value={pasteTitle}
                  onChange={(e) => setPasteTitle(e.target.value)}
                  placeholder="Title (optional)"
                  maxLength={200}
                  seed={sketchSeed("landing-title")}
                  aria-label="Title for pasted text"
                />
                <DrawablyTextarea
                  value={pastedText}
                  onChange={(e) => setPastedText(e.target.value)}
                  placeholder="Paste the text to narrate…"
                  rows={10}
                  seed={sketchSeed("landing-body")}
                  aria-label="Text to narrate"
                  className="min-h-[220px]"
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
              </DrawablyCard>
            )}
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1, delay: 0.8 }}
          >
            <DrawablyButton
              variant="solid"
              seed={sketchSeed("landing-create")}
              state={isUploading ? "loading" : "idle"}
              disabled={isUploading || !canSubmit}
              onClick={handleSubmit}
            >
              {ctaLabel}
            </DrawablyButton>
          </motion.div>
        </div>
      </section>

      <section className="py-16 px-8">
        <div className="max-w-3xl mx-auto grid sm:grid-cols-3 gap-6">
          {LANDING.features.map((feature) => (
            <DrawablyCard
              key={feature.label}
              seed={sketchSeed(`landing-feature-${feature.label}`)}
              className="text-left space-y-2"
            >
              <div className="text-sm uppercase tracking-wider text-muted-foreground">
                {feature.label}
              </div>
              <p className="text-sm leading-relaxed font-serif">
                {feature.detail}
              </p>
            </DrawablyCard>
          ))}
        </div>
      </section>

      <footer className="py-12 px-8">
        <div className="max-w-3xl mx-auto flex flex-col md:flex-row justify-between items-center gap-6 text-sm text-muted-foreground">
          <div className="tracking-[0.2em] uppercase font-serif">Echomancer</div>
          <div className="text-xs max-w-md md:text-right space-y-2">
            <p>{LANDING.privacy}</p>
            <Link href="/privacy" className="underline underline-offset-4">
              Privacy
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
