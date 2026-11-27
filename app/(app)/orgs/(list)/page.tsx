import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { OrgsView } from "@/components/views/OrgsView";
import { listMyOrgs } from "@/lib/db/orgs";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { orgsNotice } from "@/lib/ui/messages";
import { logoUrl } from "@/lib/orgs/logo";
import { createOrgAction } from "../actions";
import { createForetagAction } from "../foretag-actions";
import { listMyForetag } from "@/lib/db/foretag";
import { canCreateForetag } from "@/lib/foretag/gate";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("orgs"))("metaTitle") };
}

export default async function OrgsPage({ searchParams }: { searchParams: Promise<{ fel?: string; klart?: string }> }) {
  const { fel, klart } = await searchParams;
  const db = await createSupabaseServerClient();
  const [orgs, companies, { data: me }] = await Promise.all([listMyOrgs(db), listMyForetag(db), db.auth.getUser()]);
  const notice = orgsNotice(fel, klart, await getLocale());

  return (
    <OrgsView
      orgs={orgs.map(({ id, name, role, logo_updated_at }) => ({ id, name, role, logoUrl: logoUrl(id, logo_updated_at) }))}
      notice={fel === "invalid" ? null : notice}
      nameError={fel === "invalid" ? notice?.text : undefined}
      createOrg={createOrgAction}
      companies={companies}
      // Företag (0050): only the allow-list may create one until a DPA exists.
      createForetag={canCreateForetag(me.user?.email) ? createForetagAction : undefined}
    />
  );
}
