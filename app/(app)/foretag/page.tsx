import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { ForetagListView } from "@/components/views/ForetagListView";
import { listMyForetag } from "@/lib/db/foretag";
import { canCreateForetag } from "@/lib/foretag/gate";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { orgsNotice } from "@/lib/ui/messages";
import { createForetagAction } from "../orgs/foretag-actions";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("foretag.list"))("metaTitle") };
}

/** Företag (0050): the user's companies and Skapa ett företag. A company is not a förening, so not on /orgs. */
export default async function ForetagListPage({ searchParams }: { searchParams: Promise<{ fel?: string; klart?: string }> }) {
  const { fel, klart } = await searchParams;
  const db = await createSupabaseServerClient();
  const [companies, { data: me }] = await Promise.all([listMyForetag(db), db.auth.getUser()]);
  const notice = orgsNotice(fel, klart, await getLocale());

  return (
    <ForetagListView
      companies={companies}
      notice={fel === "invalid" ? null : notice}
      nameError={fel === "invalid" ? notice?.text : undefined}
      // Only the allow-list may create one until a DPA exists.
      createForetag={canCreateForetag(me.user?.email) ? createForetagAction : undefined}
    />
  );
}
