import { z } from "zod";

export const createJobSchema = z.object({
  pdfStoragePath: z.string().min(1, "PDF storage path is required"),
  bookTitle: z.string().min(1).max(200).optional().default("Untitled"),
  voiceStoragePath: z.string().optional(),
  videoId: z.string().optional(),
  voiceName: z.string().max(200).optional().default("Custom Voice"),
  // ZONOS: Supports up to 30s voice samples (vs 15s for F5-TTS)
  startTime: z.number().min(0).max(600).optional().default(0),
  endTime: z.number().min(0).max(600).optional().default(30),
}).refine(
  (data) => data.voiceStoragePath || data.videoId,
  { message: "Either voiceStoragePath or videoId is required" }
);

// ZONOS: Audio upload validation
export const audioUploadSchema = z.object({
  file: z.instanceof(File).refine(
    (file) => file.size <= 100 * 1024 * 1024, // 100MB max (Zonos can handle larger samples)
    "Audio file must be less than 100MB"
  ),
});

export const youtubeSearchSchema = z.object({
  q: z.string().min(1, "Search query is required").max(500),
  maxResults: z.coerce.number().min(1).max(50).optional().default(8),
});

export const paginationSchema = z.object({
  page: z.coerce.number().min(1).optional().default(1),
  limit: z.coerce.number().min(1).max(100).optional().default(20),
});

export type CreateJobInput = z.infer<typeof createJobSchema>;
export type YoutubeSearchInput = z.infer<typeof youtubeSearchSchema>;
export type PaginationInput = z.infer<typeof paginationSchema>;
