import { z } from "zod";

const stockProviderSchema = z.enum(["google", "grok", "gemini", "openrouter"]);

/** Stock voice: stream (listen now) or takehome (full downloadable book) */
const stockJobSchema = z.object({
  mode: z.literal("stock").default("stock"),
  jobKind: z.enum(["stream", "takehome"]),
  pdfStoragePath: z.string().min(1, "PDF storage path is required"),
  bookTitle: z.string().min(1).max(200).optional().default("Untitled"),
  catalogVoiceId: z.string().min(1).optional(),
  ttsProvider: stockProviderSchema.optional(),
  providerVoiceId: z.string().min(1).optional(),
  voiceName: z.string().max(200).optional(),
  charCount: z.coerce.number().min(0).optional(),
  ttsOptions: z
    .object({
      speed: z.number().min(0.5).max(2).optional(),
      language: z.string().optional(),
      model: z.string().optional(),
    })
    .optional(),
  parentJobId: z.string().optional(),
});

export const createJobSchema = stockJobSchema;

export const paginationSchema = z.object({
  page: z.coerce.number().min(1).optional().default(1),
  limit: z.coerce.number().min(1).max(100).optional().default(20),
});

export type CreateJobInput = z.infer<typeof createJobSchema>;
export type PaginationInput = z.infer<typeof paginationSchema>;
