import type { Metadata } from "next";
import { PublicShell } from "@/components/views/PublicShell";
import { StatusView, type StatusData } from "@/components/views/StatusView";
import { getEnv } from "@/lib/env";
import { loadStatus } from "@/lib/status";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const metadata: Metadata = { title: "Status" };

// Public, no auth. Read with the service role on the server and cached for a minute.
export const revalidate = 60;

export default async function StatusPage() {
  let data: StatusData | null = null;
  try {
    data = await loadStatus(supabaseAdmin(), getEnv().KILL_SWITCH);
  } catch (error) {
    console.error("status: load failed", error instanceof Error ? error.message : error);
  }
  return (
    <PublicShell signedIn={false}>
      <StatusView data={data} />
    </PublicShell>
  );
}
