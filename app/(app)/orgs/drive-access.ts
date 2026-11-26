"use server";

import { redirect } from "next/navigation";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { IMPORT_SCOPES } from "@/lib/google/scopes";
import { appOrigin } from "@/lib/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * "Ge åtkomst" in the protocol import: incremental Google consent for drive.readonly, asked
 * ONLY of an admin of the förening, ONLY here (never at sign-in). Same Supabase OAuth as the
 * login, with include_granted_scopes so the new refresh token keeps drive.file too, and the
 * admin's own account as login_hint. /auth/callback stores the token (with its real scope) and
 * returns to /orgs/<id>/protokoll, which opens the import again (`?drive=ok|nej`).
 */
export async function requestDriveAccess(formData: FormData): Promise<void> {
  const orgId = formData.get("orgId")?.toString() ?? "";
  if (!isUuid(orgId)) redirect("/");
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if ((await myRole(supabase, orgId)) !== "admin") redirect(`/orgs/${orgId}`);

  const next = `/orgs/${orgId}/protokoll`;
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${appOrigin()}/auth/callback?next=${encodeURIComponent(next)}&atkomst=drive`,
      scopes: IMPORT_SCOPES.join(" "),
      queryParams: {
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        ...(user.email ? { login_hint: user.email } : {}),
      },
    },
  });
  if (error || !data.url) redirect(`${next}?drive=fel`);
  redirect(data.url);
}
