"use client";

import { useEffect, useState } from "react";

/** One short waiting line. */
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
    <span className="text-sm text-muted-foreground" aria-live="off">
      {line}
    </span>
  );
}
