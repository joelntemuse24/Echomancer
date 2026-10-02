"use client";

import { Loader2 } from "lucide-react";
import type { CloneQualityRisk } from "@/lib/upload-client";
import { REFERENCE_QUALITY_COPY } from "@/lib/tts/reference-quality/config";

/**
 * Shown when the worker reference gate thinks a clip may not clone well.
 * The sample is already uploaded, so "Continue anyway" does not upload again.
 * Same reading-room treatment as the rest of the voice page: hairline-free
 * text, one issue line, underlined actions.
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
  const actionClass =
    "inline-flex min-h-11 items-center text-sm text-foreground underline decoration-foreground/70 underline-offset-[7px] transition-opacity hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <div role="alert" className="space-y-2">
      <p className="text-sm text-foreground">{risk.headline}</p>
      <p className="text-sm text-muted-foreground">{risk.body}</p>
      {issue ? <p className="text-sm text-muted-foreground">{issue}</p> : null}
      <div className="flex flex-wrap gap-x-5">
        <button type="button" onClick={onChooseAnother} disabled={busy} className={actionClass}>
          {REFERENCE_QUALITY_COPY.chooseAnother}
        </button>
        <button type="button" onClick={onContinue} disabled={busy} className={actionClass}>
          {busy ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
          {REFERENCE_QUALITY_COPY.continueAnyway}
        </button>
      </div>
    </div>
  );
}
