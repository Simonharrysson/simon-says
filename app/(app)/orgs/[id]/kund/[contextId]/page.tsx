import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { CustomerView } from "@/components/foretag/CustomerView";
import { isUuid } from "@/lib/db/ids";
import { getOrg } from "@/lib/db/orgs";
import { listGroups } from "@/lib/db/foretag";
import { loadCustomerPage } from "@/lib/foretag/page";
import type { Locale } from "@/lib/i18n/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { orgNotice } from "@/lib/ui/messages";
import { renameCustomerAction } from "../../../foretag-actions";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("foretag"))("customers.title"), robots: { index: false, follow: false } };
}

/** A Företag customer (0050): its meetings the viewer may see and their open tasks. Members only. */
export default async function CustomerPage({ params, searchParams }: { params: Promise<{ id: string; contextId: string }>; searchParams: Promise<{ fel?: string }> }) {
  const { id, contextId } = await params;
  const { fel } = await searchParams;
  if (!isUuid(id) || !isUuid(contextId)) notFound();
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect(`/login?next=/orgs/${id}/kund/${contextId}`);
  const org = await getOrg(db, id);
  if (!org || org.kind !== "foretag") notFound();
  const [page, groups] = await Promise.all([loadCustomerPage(db, id, contextId), listGroups(db, id)]);
  if (!page) notFound();
  const locale = (await getLocale()) as Locale;
  return (
    <CustomerView
      orgId={id}
      customer={page.customer}
      meetings={page.meetings}
      openTasks={page.openTasks}
      groups={groups}
      notice={orgNotice(fel, undefined, locale)}
      rename={renameCustomerAction}
    />
  );
}
