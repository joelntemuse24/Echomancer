import { createClient as createSupabaseClient } from "@supabase/supabase-js";

export function createClient() {
  // Browser client: only NEXT_PUBLIC_* vars are available in the browser.
  // Don't use getEnv() here — it validates server-only vars like SUPABASE_SERVICE_ROLE_KEY
  // which don't exist in the browser environment.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }
  return createSupabaseClient(url, key);
}
