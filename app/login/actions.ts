"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { GOOGLE_SCOPES } from "@/lib/google/scopes";
import { originFrom } from "@/lib/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** Start Google sign-in. The PKCE verifier lands in a cookie; /auth/callback finishes it. */
export async function signInWithGoogle(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const origin = originFrom(await headers());
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${origin}/auth/callback`,
      scopes: GOOGLE_SCOPES.join(" "),
      // offline + consent: Google returns a refresh token on every sign-in.
      queryParams: { access_type: "offline", prompt: "consent" },
    },
  });
  if (error || !data.url) redirect("/login?fel=start");
  redirect(data.url);
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
