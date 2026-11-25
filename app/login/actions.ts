"use server";

import { redirect } from "next/navigation";
import { GOOGLE_SCOPES } from "@/lib/google/scopes";
import { safeNextPath } from "@/lib/next-path";
import { appOrigin } from "@/lib/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Start Google sign-in. The PKCE verifier lands in a cookie; /auth/callback finishes it and
 * returns to the form's `next` path (e.g. an invite link) when it is a safe same-site path.
 */
export async function signInWithGoogle(formData?: FormData): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const origin = appOrigin();
  const next = safeNextPath(formData?.get("next")?.toString());
  const callback = next === "/" ? `${origin}/auth/callback` : `${origin}/auth/callback?next=${encodeURIComponent(next)}`;
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: callback,
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
