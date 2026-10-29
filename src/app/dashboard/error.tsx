"use client";

import { useEffect } from "react";
import { userFriendlyError } from "@/lib/errors-ui";

/** A dashboard route threw while rendering or fetching. */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Dashboard error:", error);
  }, [error]);

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl pb-16 font-sans">
      <div className="space-y-3 py-24 text-center">
        <p className="text-sm text-destructive" role="alert">
          {error.message
            ? userFriendlyError(error.message)
            : "Something went wrong. Try again."}
        </p>
        <button
          type="button"
          onClick={() => reset()}
          className="tap text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
