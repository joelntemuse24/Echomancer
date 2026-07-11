import { z } from "zod";

export const VOICE_CLIP_LABELS = [
  "neutral",
  "animated",
  "soft",
  "serious",
  "dialogue",
] as const;

export type VoiceClipLabel = (typeof VOICE_CLIP_LABELS)[number];

export interface VoiceClipRange {
  label: VoiceClipLabel;
  startTime: number;
  endTime: number;
}

export const voiceClipRangeSchema = z
  .object({
    label: z.enum(VOICE_CLIP_LABELS),
    startTime: z.coerce.number().min(0).max(36000),
    endTime: z.coerce.number().min(0).max(36000),
  })
  .superRefine((clip, context) => {
    const duration = clip.endTime - clip.startTime;
    if (duration < 3) {
      context.addIssue({
        code: "custom",
        message: "Voice clips must be at least 3 seconds",
        path: ["endTime"],
      });
    }
    if (duration > 30) {
      context.addIssue({
        code: "custom",
        message: "Voice clips cannot exceed 30 seconds",
        path: ["endTime"],
      });
    }
  });

export const voiceClipsSchema = z
  .array(voiceClipRangeSchema)
  .min(1)
  .max(VOICE_CLIP_LABELS.length)
  .superRefine((clips, context) => {
    const labels = new Set<VoiceClipLabel>();
    clips.forEach((clip, index) => {
      if (labels.has(clip.label)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate voice style: ${clip.label}`,
          path: [index, "label"],
        });
      }
      labels.add(clip.label);
    });
    if (!labels.has("neutral")) {
      context.addIssue({
        code: "custom",
        message: "A neutral identity clip is required",
      });
    }
  });

export function normalizeVoiceClips(input: {
  voiceClips?: VoiceClipRange[] | null;
  startTime: number;
  endTime: number;
}): VoiceClipRange[] {
  const clips =
    input.voiceClips && input.voiceClips.length > 0
      ? input.voiceClips
      : [
          {
            label: "neutral" as const,
            startTime: input.startTime,
            endTime: input.endTime,
          },
        ];
  return voiceClipsSchema.parse(clips).sort((a, b) =>
    a.label.localeCompare(b.label)
  );
}

export function primaryVoiceClip(clips: VoiceClipRange[]): VoiceClipRange {
  const primary = clips.find((clip) => clip.label === "neutral") ?? clips[0];
  if (!primary) throw new Error("At least one voice clip is required");
  return primary;
}

export function parseStoredVoiceClips(
  value: string | null | undefined,
  fallback: { startTime: number; endTime: number }
): VoiceClipRange[] {
  if (!value) return normalizeVoiceClips(fallback);
  try {
    return normalizeVoiceClips({
      ...fallback,
      voiceClips: JSON.parse(value),
    });
  } catch {
    return normalizeVoiceClips(fallback);
  }
}

export function serializeVoiceClips(clips: VoiceClipRange[]): string {
  return JSON.stringify(
    normalizeVoiceClips({
      voiceClips: clips,
      startTime: clips[0]?.startTime ?? 0,
      endTime: clips[0]?.endTime ?? 30,
    })
  );
}
