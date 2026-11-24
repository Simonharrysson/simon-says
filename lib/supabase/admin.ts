import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "@/lib/env";

let admin: SupabaseClient | undefined;

/** Service-role client. Bypasses RLS: server code only, never per-user input as table names. */
export function supabaseAdmin(): SupabaseClient {
  const env = getEnv();
  admin ??= createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return admin;
}
