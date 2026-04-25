import { z } from "zod";

const envSchema = z.object({
  // SQLite & Storage
  DB_PATH: z.string().optional().default("./data"),
  STORAGE_PATH: z.string().optional().default("./data/storage"),
  
  // Replicate (Qwen3-TTS)
  REPLICATE_API_TOKEN: z.string().min(1, "REPLICATE_API_TOKEN is required for TTS").optional(),
  
  // YouTube API
  YOUTUBE_API_KEY: z.string().min(1, "YOUTUBE_API_KEY is required").optional(),
  
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
