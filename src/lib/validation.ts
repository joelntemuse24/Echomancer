import { z } from "zod";

export const createJobSchema = z.object({
  pdfStoragePath: z.string().min(1, "PDF storage path is required"),
  bookTitle: z.string().min(1).max(200).optional().default("Untitled"),
  voiceStoragePath: z.string().min(1, "Voice storage path is required"),
  voiceName: z.string().max(200).optional().default("Custom Voice"),
  // Voice clip timestamps — start/end can be anywhere in the source audio (up to 10 hours)
  startTime: z.coerce.number().min(0).max(36000).optional().default(0),
  endTime: z.coerce.number().min(0).max(36000).optional().default(30),
  charCount: z.coerce.number().int().min(0).optional(),
  paragraphCount: z.coerce.number().int().min(0).optional(),
});

// Audio upload validation — 10MB max matches frontend limit
export const audioUploadSchema = z.object({
  file: z.instanceof(File).refine(
    (file) => file.size <= 10 * 1024 * 1024,
    "Audio file must be less than 10MB"
  ),
});

export const paginationSchema = z.object({
  page: z.coerce.number().min(1).optional().default(1),
  limit: z.coerce.number().min(1).max(100).optional().default(20),
});

export type CreateJobInput = z.infer<typeof createJobSchema>;
export type PaginationInput = z.infer<typeof paginationSchema>;
