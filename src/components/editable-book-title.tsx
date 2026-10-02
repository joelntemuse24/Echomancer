"use client";

import { Pencil } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const MAX_TITLE_CHARS = 200;

async function renameBook(jobId: string, title: string): Promise<string> {
  const response = await fetch(`/api/jobs/${jobId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "rename", bookTitle: title }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Couldn't rename. Try again.");
  return String(data.bookTitle ?? title);
}

/**
 * A book title with a quiet pencil. Enter or blur saves, Escape cancels.
 * Errors stay inline under the field.
 */
export function EditableBookTitle({
  jobId,
  title,
  onRenamed,
  children,
  inputClassName,
  buttonClassName,
}: {
  jobId: string;
  title: string;
  onRenamed: (title: string) => void;
  /** The title as it normally renders (heading or link). */
  children: ReactNode;
  inputClassName?: string;
  buttonClassName?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const start = () => {
    cancelledRef.current = false;
    setDraft(title);
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    if (cancelledRef.current || saving) return;
    const next = draft.replace(/\s+/g, " ").trim();
    if (!next || next === title) {
      setEditing(false);
      setError(null);
      return;
    }
    setSaving(true);
    try {
      onRenamed(await renameBook(jobId, next));
      setEditing(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't rename. Try again.");
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="w-full min-w-0 basis-full space-y-1">
        <input
          autoFocus
          value={draft}
          maxLength={MAX_TITLE_CHARS}
          disabled={saving}
          aria-label="Book title"
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelledRef.current = true;
              setEditing(false);
              setError(null);
            }
          }}
          className={cn(
            "w-full min-w-0 border-b border-border bg-transparent outline-none focus:border-foreground/60 disabled:opacity-60",
            inputClassName
          )}
        />
        {error ? (
          <p className="text-xs text-muted-foreground" role="status">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <>
      {children}
      <button
        type="button"
        onClick={start}
        aria-label={`Rename ${title}`}
        className={cn(
          "tap inline-flex min-h-8 min-w-8 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground",
          buttonClassName
        )}
      >
        <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </>
  );
}
