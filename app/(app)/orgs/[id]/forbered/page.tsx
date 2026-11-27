import { isForetagOrg } from "@/lib/foretag/guard";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { PrepareMeeting } from "@/components/views/PrepareMeeting";
import { isUuid } from "@/lib/db/ids";
import { getOrg, myRole } from "@/lib/db/orgs";
import { validDate } from "@/lib/prepare/draft";
import { proposedWhen } from "@/lib/prepare/when";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { stockholmDateTime } from "@/lib/calendar/events";
import { orgEvent } from "@/lib/calendar/load";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("common"))("metaPrepare"), robots: { index: false, follow: false } };
}

/**
 * Förbered möte (todo #6): any member prepares the next meeting's agenda. The date and time are
 * proposed from the förening's last meeting (same weekday, next week); the steps run in the
 * client (PrepareMeeting → /api/orgs/<id>/prepare). `?event=<id>`: prefilled from that calendar event.
 */
export default async function PreparePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ datum?: string; event?: string }> }) {
  const { id } = await params;
  const { datum, event } = await searchParams;
  if (!isUuid(id)) notFound();
  // Förening only: a Företag (0050) has none of this.
  if (await isForetagOrg(id)) notFound();
  const db = await createSupabaseServerClient();
  const org = await getOrg(db, id);
  if (!org || (await myRole(db, id)) === null) notFound();
  if (org.kind === "privat") redirect("/privat");

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
  // "Ändra" on the förening page: the prepared meeting's date.
  if (datum && validDate(datum) && datum >= when.today) {
    when.date = datum;
    when.time = "";
  }
  // "Förbered" on a calendar event (todo #14): its date, time and title, read again from the
  // förening's calendar with the member's own grant (never taken from the URL).
  let eventTitle: string | null = null;
  const user = event ? (await db.auth.getUser()).data.user : null;
  const picked = user && event ? await orgEvent(user.id, org, event) : null;
  if (picked) {
    const at = stockholmDateTime(picked.start);
    if (at.date >= when.today) {
      when.date = at.date;
      when.time = at.time;
      eventTitle = picked.title || null;
    }
  }

  return <PrepareMeeting orgId={org.id} orgName={org.name} today={when.today} defaultDate={when.date} defaultTime={when.time} eventTitle={eventTitle} />;
}
