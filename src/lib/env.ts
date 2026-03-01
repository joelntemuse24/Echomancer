import { z } from "zod";

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url("NEXT_PUBLIC_SUPABASE_URL must be a valid URL"),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, "NEXT_PUBLIC_SUPABASE_ANON_KEY is required"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),
  YOUTUBE_API_KEY: z.string().min(1, "YOUTUBE_API_KEY is required").optional(),
  REPLICATE_API_TOKEN: z.string().min(1, "REPLICATE_API_TOKEN is required").optional(),
  TRIGGER_SECRET_KEY: z.string().min(1).optional(),
  TRIGGER_API_URL: z.string().url().optional(),
  F5TTS_MODEL: z.string().optional(),
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),
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
      `❌ Missing or invalid environment variables:\n${missing.join("\n")}\n\nCopy .env.example to .env.local and fill in the values.`
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
