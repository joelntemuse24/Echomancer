import { z } from "zod";

const stockProviderSchema = z.enum(["google", "grok", "gemini", "openrouter"]);

/**
 * Uploads always land at `pdfs/<uuid>/content.txt`. Pinning the shape here
 * stops a caller from pointing a job at an arbitrary key (another visitor's
 * upload, a generated audio segment, a traversal attempt) before the ownership
 * lookup even runs.
 */
export const uploadStoragePathSchema = z
  .string()
  .regex(
    /^pdfs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/content\.txt$/,
    "pdfStoragePath must reference an uploaded document"
  );

/** Stock voice: stream (listen now) or takehome (full downloadable book) */
const stockJobSchema = z.object({
  mode: z.literal("stock").default("stock"),
  jobKind: z.enum(["stream", "takehome"]),
  pdfStoragePath: uploadStoragePathSchema,
  bookTitle: z.string().min(1).max(200).optional().default("Untitled"),
  catalogVoiceId: z.string().min(1).max(300).optional(),
  ttsProvider: stockProviderSchema.optional(),
  providerVoiceId: z.string().min(1).max(200).optional(),
  voiceName: z.string().max(200).optional(),
  charCount: z.coerce.number().min(0).optional(),
  ttsOptions: z
    .object({
      speed: z.number().min(0.5).max(2).optional(),
      language: z.string().max(32).optional(),
      model: z.string().max(200).optional(),
    })
    .optional(),
  parentJobId: z.string().uuid().optional(),
});

export const createJobSchema = stockJobSchema;

export const paginationSchema = z.object({
  page: z.coerce.number().min(1).max(1000).optional().default(1),
  limit: z.coerce.number().min(1).max(100).optional().default(20),
});

export type CreateJobInput = z.infer<typeof createJobSchema>;
export type PaginationInput = z.infer<typeof paginationSchema>;
