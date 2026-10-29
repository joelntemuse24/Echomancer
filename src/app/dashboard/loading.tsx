import { Loader2 } from "lucide-react";

/** Shown while a dashboard route's first payload is on the wire. */
export default function DashboardLoading() {
  return (
    <div
      className="mx-auto w-full min-w-0 max-w-3xl space-y-16 pb-16 font-sans"
      aria-busy="true"
      aria-live="polite"
    >
      <div className="h-12 w-48 animate-pulse rounded-sm bg-accent/60" />
      <div className="space-y-4">
        {[0, 1, 2].map((row) => (
          <div
            key={row}
            className="h-24 w-full animate-pulse rounded-sm border border-border/20 bg-accent/20"
          />
        ))}
      </div>
      <div className="flex justify-center">
        <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
      <span className="sr-only">Loading</span>
    </div>
  );
}
