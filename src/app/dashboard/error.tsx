"use client";

import { Button } from "@/components/ui/button";
import { AlertCircle, RotateCcw, ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  return (
    <div className="max-w-2xl mx-auto pt-16 text-center">
      <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-destructive/10 flex items-center justify-center">
        <AlertCircle className="w-6 h-6 text-destructive" />
      </div>
      <h2 className="text-2xl font-serif mb-2" style={{ fontWeight: 300 }}>
        Something went wrong
      </h2>
      <p className="text-sm text-muted-foreground mb-6 max-w-md mx-auto">
        {error.message || "An unexpected error occurred. Please try again."}
      </p>
      <div className="flex items-center justify-center gap-3">
        <Button variant="outline" onClick={() => router.push("/")} className="gap-2">
          <ArrowLeft className="w-4 h-4" />
          Home
        </Button>
        <Button onClick={reset} className="gap-2">
          <RotateCcw className="w-4 h-4" />
          Try again
        </Button>
      </div>
    </div>
  );
}
