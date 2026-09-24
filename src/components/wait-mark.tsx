"use client";

import { useEffect, useState } from "react";

/** Quiet waiting mark: three soft dots and one short line. */
export function WaitMark({ phrases }: { phrases: readonly string[] }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (phrases.length < 2) return;
    const id = window.setInterval(() => {
      setIndex((current) => (current + 1) % phrases.length);
    }, 3200);
    return () => window.clearInterval(id);
  }, [phrases]);

  const line = phrases[index] ?? phrases[0] ?? "";

  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1" aria-hidden="true">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="h-1 w-1 rounded-full bg-foreground/55 animate-pulse"
            style={{ animationDelay: `${dot * 180}ms` }}
          />
        ))}
      </span>
      <span aria-live="off">{line}</span>
    </span>
  );
}
