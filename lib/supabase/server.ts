import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getEnv } from "@/lib/env";
import { sessionCookieOptions } from "@/lib/supabase/cookie-options";

/** Per-request Supabase client acting as the signed-in user (session in cookies). */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const env = getEnv();
  return createServerClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    cookieOptions: sessionCookieOptions(),
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component, where cookies are read-only. Harmless as long as
          // a route handler / server action / proxy refreshes the session.
        }
      },
    },
  });
}
