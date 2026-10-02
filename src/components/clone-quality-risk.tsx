"use client";

import { Loader2 } from "lucide-react";
import type { CloneQualityRisk } from "@/lib/upload-client";
import { REFERENCE_QUALITY_COPY } from "@/lib/tts/reference-quality/config";

/**
 * Shown when the worker reference gate thinks a clip may not clone well.
 * The sample is already uploaded, so "Continue anyway" does not upload again.
 * Same amber notice and copper underline as the rest of the voice page:
 * one issue line, then the two actions.
 */
export function CloneQualityRiskNotice({
  risk,
  busy,
  onChooseAnother,
  onContinue,
}: {
  risk: CloneQualityRisk;
  busy?: boolean;
  onChooseAnother: () => void;
  onContinue: () => void;
}) {
  const issue = risk.issues[0]?.detail;
  return (
    <div
      role="alert"
      className="space-y-1 border border-amber-500/30 bg-amber-500/5 px-3 py-3"
    >
      <p className="text-sm text-amber-800 dark:text-amber-300">{risk.headline}</p>
      <p className="text-xs leading-relaxed text-muted-foreground">{risk.body}</p>
      {issue ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{issue}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-5 pt-2">
        <button
          type="button"
          onClick={onChooseAnother}
          disabled={busy}
          className="inline-flex min-h-11 items-center border-b border-copper px-1 pb-0.5 text-sm text-foreground transition-opacity hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {REFERENCE_QUALITY_COPY.chooseAnother}
        </button>
        <button
          type="button"
          onClick={onContinue}
          disabled={busy}
          className="inline-flex min-h-11 items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {REFERENCE_QUALITY_COPY.continueAnyway}
        </button>
      </div>
    </div>
  );
}
