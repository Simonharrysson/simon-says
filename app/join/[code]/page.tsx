import type { Metadata } from "next";
import { joinOrgAction } from "@/app/(app)/orgs/actions";
import { signInWithGoogle, switchAccount } from "@/app/login/actions";
import { getTranslations } from "next-intl/server";
import { JoinView } from "@/components/views/JoinView";
import { PublicShell } from "@/components/views/PublicShell";
import { inviteOrgName } from "@/lib/db/orgs";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
// Joining shares the förening's earlier meeting Docs after the redirect (after()).
export const maxDuration = 60;
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("join"))("metaTitle") };
}

const CODE = /^[A-Za-z0-9_-]{1,64}$/;

/** Invite link. Joining is a POST (button), never a side effect of opening the link. */
export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();

  if (!user) {
    return (
      <PublicShell signedIn={false}>
        <JoinView state="signed-out" code={CODE.test(code) ? code : ""} signIn={signInWithGoogle} />
      </PublicShell>
    );
  }

  const name = CODE.test(code) ? await inviteOrgName(db, code) : null;
  return (
    <PublicShell signedIn>
      {name ? <JoinView state="ready" code={code} orgName={name} join={joinOrgAction} email={user.email} switchAccount={switchAccount} /> : <JoinView state="invalid" />}
    </PublicShell>
  );
}
