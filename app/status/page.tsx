import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PublicShell } from "@/components/views/PublicShell";
import { StatusView, type StatusData } from "@/components/views/StatusView";
import { getEnv } from "@/lib/env";
import { loadStatus } from "@/lib/status";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("status"))("metaTitle") };
}

// Public, no auth. Read with the service role on the server and cached for a minute.
export const revalidate = 60;

export default async function StatusPage() {
  // A failed load throws (error page) instead of rendering an empty state: a thrown render is
  // not cached, so a failure can't stick for the 60 s revalidate window.
  const data: StatusData = await loadStatus(supabaseAdmin(), getEnv().KILL_SWITCH);
  return (
    <PublicShell signedIn={false}>
      <StatusView data={data} />
    </PublicShell>
  );
}
