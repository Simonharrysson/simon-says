import type { Metadata } from "next";
import { OrgsView } from "@/components/views/OrgsView";
import { listMyOrgs } from "@/lib/db/orgs";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { orgsNotice } from "@/lib/ui/messages";
import { createOrgAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Föreningar" };

export default async function OrgsPage({ searchParams }: { searchParams: Promise<{ fel?: string; klart?: string }> }) {
  const { fel, klart } = await searchParams;
  const db = await createSupabaseServerClient();
  const orgs = await listMyOrgs(db);
  const notice = orgsNotice(fel, klart);

  return (
    <OrgsView
      orgs={orgs.map(({ id, name, role }) => ({ id, name, role }))}
      notice={fel === "invalid" ? null : notice}
      nameError={fel === "invalid" ? notice?.text : undefined}
      createOrg={createOrgAction}
    />
  );
}
