import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PrepareMeeting } from "@/components/views/PrepareMeeting";
import { isUuid } from "@/lib/db/ids";
import { getOrg, myRole } from "@/lib/db/orgs";
import { proposedWhen } from "@/lib/prepare/when";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Förbered möte", robots: { index: false, follow: false } };

/**
 * Förbered möte (todo #6): any member prepares the next meeting's agenda. The date and time are
 * proposed from the förening's last meeting (same weekday, next week); the steps run in the
 * client (PrepareMeeting → /api/orgs/<id>/prepare).
 */
export default async function PreparePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const db = await createSupabaseServerClient();
  const org = await getOrg(db, id);
  if (!org || (await myRole(db, id)) === null) notFound();

  // RLS: this förening's meetings only. The last real one sets the proposed weekday and time.
  const { data: last } = await db
    .from("meetings")
    .select("started_at")
    .eq("org_id", id)
    .eq("is_test", false)
    .in("status", ["done", "abandoned"])
    .order("started_at", { ascending: false })
    .limit(1);
  const when = proposedWhen(new Date(), (last?.[0]?.started_at as string | undefined) ?? null);

  return <PrepareMeeting orgId={org.id} orgName={org.name} today={when.today} defaultDate={when.date} defaultTime={when.time} />;
}
