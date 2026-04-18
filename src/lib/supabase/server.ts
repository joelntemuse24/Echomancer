import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "@/lib/env";

export function createServerClient() {
  const env = getEnv();
  return createSupabaseClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY
  );
}
