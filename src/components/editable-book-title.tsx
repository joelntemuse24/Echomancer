"use client";

import { useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const MAX_TITLE_CHARS = 200;

export type BookTitleParts = {
  editing: boolean;
  field: ReactNode;
  button: ReactNode;
};

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
  label = "Rename",
}: {
  jobId: string;
  title: string;
  onRenamed: (title: string) => void;
  /**
   * The title as it normally renders, or a render prop when the rename
   * control needs to sit somewhere else on the screen.
   */
  children: ReactNode | ((parts: BookTitleParts) => ReactNode);
  inputClassName?: string;
  buttonClassName?: string;
  label?: string;
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

  const field = (
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

  const button = (
    <button
      type="button"
      onClick={start}
      aria-label={`Rename ${title}`}
      className={cn(
        "inline-flex min-h-11 shrink-0 items-center text-xs text-muted-foreground transition-colors hover:text-foreground",
        buttonClassName
      )}
    >
      {label}
    </button>
  );

  if (typeof children === "function") {
    return children({ editing, field, button });
  }

  if (editing) return field;

  return (
    <>
      {children}
      {button}
    </>
  );
}
