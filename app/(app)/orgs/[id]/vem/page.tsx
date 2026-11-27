import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { WhoamiView } from "@/components/views/WhoamiView";
import { isUuid } from "@/lib/db/ids";
import { getOrg, listPeople, myRole } from "@/lib/db/orgs";
import { claimable, isLinked, parseWhoamiError, suggestedName } from "@/lib/people/whoami";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { addSelfAction, claimPersonAction } from "../../actions";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("join.whoami"))("metaTitle"), robots: { index: false, follow: false } };
}

/**
 * "Vem av dessa är du?" (0051): where "Gå med" lands when no person in the förening is linked to
 * the new member yet. Already linked: the förening. `?ny=1` opens "Jag finns inte med"; `?fel=` a refusal.
 */
export default async function WhoamiPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ny?: string; fel?: string }> }) {
  const { id } = await params;
  const { ny, fel } = await searchParams;
  if (!isUuid(id)) notFound();
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect(`/login?next=/orgs/${id}/vem`);
  const org = await getOrg(db, id);
  if (!org) notFound();
  if (org.kind === "privat") redirect("/privat");
  // Företag (0050): admins place people; the picker is föreningar only (0051).
  if (org.kind === "foretag") redirect(`/orgs/${id}`);
  if ((await myRole(db, id)) === null) notFound();
  const people = await listPeople(db, id);
  if (isLinked(people, user.id)) redirect(`/orgs/${id}`);

  return (
    <WhoamiView
      orgId={id}
      orgName={org.name}
      people={claimable(people, user.email)}
      adding={ny === "1"}
      error={parseWhoamiError(fel)}
      suggestedName={suggestedName(user.user_metadata)}
      claim={claimPersonAction}
      addSelf={addSelfAction}
    />
  );
}
