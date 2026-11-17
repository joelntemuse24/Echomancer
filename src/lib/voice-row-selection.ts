export type VoiceRowKind = "stock" | "kokoro" | "clone";

/**
 * Every row uses this rule. Previewing a voice selects it. Stopping a preview
 * that is already playing leaves the selection where it is. The pressed row
 * and the id that will be submitted are the same value.
 */
export function voiceIdAfterRowAction(input: {
  action: "preview" | "stop-preview" | "select";
  voiceId: string;
  selectedId: string | null;
  kind?: VoiceRowKind;
}): string | null {
  if (input.action === "stop-preview") return input.selectedId;
  return input.voiceId;
}

export function rowIsPressed(selectedId: string | null, voiceId: string): boolean {
  return selectedId === voiceId;
}

export function submittedVoiceId(selectedId: string | null): string | null {
  return selectedId;
}
