import { z } from "zod";

const envSchema = z.object({
  // SQLite & Storage
  DB_PATH: z.string().optional().default("./data"),
  STORAGE_PATH: z.string().optional().default("./data/storage"),

  // Stock TTS — OpenRouter (one key for all speech models including Minimax HD)
  OPENROUTER_API_KEY: z.string().optional(),
  OPEN_ROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().url().optional(),
  OPENROUTER_CATALOG_PUBLIC: z.string().optional(),

  // Direct stock TTS providers (optional fallback if not using OpenRouter)
  GOOGLE_TTS_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_TTS_MODEL: z.string().optional(),
  XAI_API_KEY: z.string().optional(),
  GROK_API_KEY: z.string().optional(),
  XAI_TTS_URL: z.string().url().optional(),

  // Premium HD voice gate (Minimax etc.)
  PREMIUM_HD_ENABLED: z.string().optional(),
  PREMIUM_HD_ALLOWLIST: z.string().optional(),
  INTERNAL_JOB_SECRET: z.string().optional(),

  // Stream budget & pricing
  STREAM_MAX_AUDIO_SECONDS: z.string().optional(),
  STREAM_CHARS_PER_MINUTE: z.string().optional(),
  TTS_PRICE_MARKUP: z.string().optional(),
  TTS_PRICE_FIXED_EUR: z.string().optional(),
  TTS_USD_TO_EUR: z.string().optional(),
  TTS_MIN_PRICE_EUR: z.string().optional(),

  // App URL
  NEXT_PUBLIC_APP_URL: z.string().url().optional().default("http://localhost:3000"),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (_env) return _env;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const missing = result.error.issues.map(
      (e) => `  - ${e.path.join(".")}: ${e.message}`
    );
    console.error(
      `❌ Invalid environment variables:\n${missing.join("\n")}`
    );
    throw new Error("Invalid environment configuration");
  }

  _env = result.data;
  return _env;
}

export function getEnvSafe(): Partial<Env> {
  const result = envSchema.safeParse(process.env);
  return result.success ? result.data : {};
}
