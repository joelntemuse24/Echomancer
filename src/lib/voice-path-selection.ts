/**
 * Which catalog id stays selected when the voice page changes path.
 *
 * Opening "Clone a voice" lists clones. It does not pick one. A stock voice
 * the listener already chose (Sowell, Andrew, …) stays selected until they
 * tap a clone. Choosing a clone is that tap.
 */
export function voiceIdAfterPathChange(input: {
  path: "standard" | "clone";
  selectedId: string | null;
  pathIds: readonly string[];
}): string | null {
  if (input.selectedId && input.pathIds.includes(input.selectedId)) {
    return input.selectedId;
  }
  if (input.path === "clone") return input.selectedId;
  return input.pathIds[0] ?? input.selectedId;
}
