import type { Metadata } from "next";
import { PrivatHomeView } from "@/components/privat/PrivatHomeView";
import { privatNotice } from "@/lib/privat/messages";
import { loadSpace } from "@/lib/privat/load";
import { privatTitle } from "@/lib/privat/format";
import { ensurePrivatSpace } from "@/lib/privat/space";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Privat" };

/** The user's own space (0045), created on the first visit. */
export default async function PrivatPage({ searchParams }: { searchParams: Promise<{ fel?: string; klart?: string }> }) {
  const { fel, klart } = await searchParams;
  const db = await createSupabaseServerClient();
  const spaceId = await ensurePrivatSpace(db);
  const { contexts, running } = await loadSpace(db, spaceId);
  const runningContext = running ? contexts.find((c) => c.id === running.context_id) : null;
  return (
    <PrivatHomeView
      startHref={`/meetings/ny/${spaceId}`}
      contexts={contexts}
      running={running ? { href: `/meetings/${running.id}`, label: privatTitle(runningContext?.name ?? "Inspelning", running.started_at) } : null}
      notice={privatNotice(fel, klart)}
    />
  );
}
