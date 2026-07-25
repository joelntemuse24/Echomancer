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

/** Premium MOSS custom voice clone */
const cloneJobSchema = z.object({
  mode: z.literal("clone"),
  jobKind: z.literal("clone").optional().default("clone"),
  pdfStoragePath: z.string().min(1, "PDF storage path is required"),
  bookTitle: z.string().min(1).max(200).optional().default("Untitled"),
  voiceStoragePath: z.string().min(1, "Voice storage path is required"),
  voiceName: z.string().max(200).optional().default("Custom Voice"),
  startTime: z.coerce.number().min(0).max(36000).optional().default(0),
  endTime: z.coerce.number().min(0).max(36000).optional().default(30),
});

/**
 * Discriminated create-job payload.
 * Legacy clients that only send voiceStoragePath are treated as clone.
 */
export const createJobSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== "object") return raw;
  const body = raw as Record<string, unknown>;
  if (body.mode === "stock" || body.jobKind === "stream" || body.jobKind === "takehome") {
    return { mode: "stock", ...body };
  }
  if (body.mode === "clone" || body.voiceStoragePath) {
    return { mode: "clone", jobKind: "clone", ...body };
  }
  return body;
}, z.discriminatedUnion("mode", [stockJobSchema, cloneJobSchema]));

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
