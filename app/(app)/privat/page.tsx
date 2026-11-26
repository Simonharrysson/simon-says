import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { PrivatHomeView } from "@/components/privat/PrivatHomeView";
import { privatNotice } from "@/lib/privat/messages";
import { loadSpace } from "@/lib/privat/load";
import { privatTitle } from "@/lib/privat/format";
import { ensurePrivatSpace } from "@/lib/privat/space";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("privat"))("metaTitle") };
}

/** The user's own space (0045), created on the first visit. */
export default async function PrivatPage({ searchParams }: { searchParams: Promise<{ fel?: string; klart?: string }> }) {
  const { fel, klart } = await searchParams;
  const db = await createSupabaseServerClient();
  const spaceId = await ensurePrivatSpace(db);
  const { contexts, running } = await loadSpace(db, spaceId);
  const runningContext = running ? contexts.find((c) => c.id === running.context_id) : null;
  const t = await getTranslations("privat");
  const locale = (await getLocale()) === "en" ? "en" : "sv";
  return (
    <PrivatHomeView
      startHref={`/meetings/ny/${spaceId}`}
      contexts={contexts}
      running={running ? { href: `/meetings/${running.id}`, label: privatTitle(runningContext?.name ?? t("home.runningFallback"), running.started_at, locale) } : null}
      notice={privatNotice((k) => t(k as never), fel, klart)}
    />
  );
}
