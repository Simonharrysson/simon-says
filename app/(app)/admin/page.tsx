import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { AdminView } from "@/components/admin/AdminView";
import { mayOpenAdmin } from "@/lib/admin/gate";
import { loadAdminDashboard } from "@/lib/admin/load";
import { getEnv } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("admin"))("metaTitle"), robots: { index: false, follow: false } };
}

/**
 * Insikter: the internal dashboard for the Simon Says team (ADMIN_EMAILS). Linked from nowhere;
 * everyone else gets a 404 (the proxy answers it with the status; this page and its loader check
 * again). Counts and org names only, read with the service role (migration 0066).
 */
export default async function AdminPage() {
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user || !mayOpenAdmin(user.email, getEnv())) notFound();
  const { overview, orgs } = await loadAdminDashboard(user.email);
  return <AdminView overview={overview} orgs={orgs} updatedAt={new Date().toISOString()} />;
}
