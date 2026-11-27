"use server";

import { redirect } from "next/navigation";
import { mcpConfigured, mcpStore } from "@/lib/mcp/deps";
import { approve, deny } from "@/lib/mcp/endpoints";
import { appOrigin } from "@/lib/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Godkänn / Avbryt on the consent page. Server actions: Next checks the request's Origin against
// the host (CSRF), and the user comes from the session cookie, never from the form.

export async function approveConnection(formData: FormData): Promise<void> {
  const id = String(formData.get("request") ?? "");
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/koppla/${id}`)}`);
  const store = mcpStore();
  // The kill switch again: the page may have been open since before it was turned off.
  const to = mcpConfigured() ? await approve(id, user.id, store, appOrigin()) : await deny(id, store, appOrigin());
  redirect(to ?? `/koppla/${id}`);
}

export async function denyConnection(formData: FormData): Promise<void> {
  const id = String(formData.get("request") ?? "");
  const to = await deny(id, mcpStore(), appOrigin());
  redirect(to ?? "/installningar");
}
