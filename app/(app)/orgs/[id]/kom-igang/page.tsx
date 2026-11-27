import { isForetagOrg } from "@/lib/foretag/guard";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { Onboarding } from "@/components/onboarding/Onboarding";
import { isUuid } from "@/lib/db/ids";
import { orgMemberList, type OrgMember } from "@/lib/db/members";
import { getOrg, listPeople, myRole } from "@/lib/db/orgs";
import { getEnv, pickerEnabled } from "@/lib/env";
import { FORMAT_NAMES } from "@/lib/formats/standard";
import { orgDefaultFormat } from "@/lib/formats/store";
import { historySummary } from "@/lib/history/store";
import { loadOnboarding } from "@/lib/onboarding/store";
import { resumeStep, stepFromNumber, type OnboardingState } from "@/lib/onboarding/steps";
import { appOrigin } from "@/lib/origin";
import { boardRows } from "@/lib/people/board";
import type { InviteRow } from "@/lib/invites/rules";
import { inviterNameFor, listInvites } from "@/lib/invites/send";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("common"))("metaKomIgang"), robots: { index: false, follow: false } };
}

const EMPTY: OnboardingState = { done: [], skipped: [], completedAt: null, dismissedAt: null };

/**
 * Kom igång (todo #5): the förening's admins set it up one calm step at a time. `?steg=1..6`
 * (or `klart`) opens a step; without it the first step not done yet. Members go to the förening.
 * A förening from before onboarding has no row: the steps still work, progress is not stored.
 */
export default async function OnboardingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ steg?: string }> }) {
  const { id } = await params;
  const { steg } = await searchParams;
  if (!isUuid(id)) notFound();
  // Förening only: a Företag (0050) has none of this.
  if (await isForetagOrg(id)) notFound();
  const db = await createSupabaseServerClient();
  const org = await getOrg(db, id);
  if (!org) notFound();
  if (org.kind === "privat") redirect("/privat");
  const role = await myRole(db, id);
  if (role === null) notFound();
  if (role !== "admin") redirect(`/orgs/${id}`);

  // Service role for the invites: only after the admin check above.
  const [state, people, members, format, history, user, invites] = await Promise.all([
    loadOnboarding(db, id),
    listPeople(db, id),
    orgMemberList(id).catch((): OrgMember[] => []),
    orgDefaultFormat(db, id),
    historySummary(db, id).catch(() => ({ count: 0 })),
    db.auth.getUser(),
    listInvites(supabaseAdmin(), id).catch((): InviteRow[] => []),
  ]);
  const s = state ?? EMPTY;
  const step = steg === "klart" ? "klart" : (stepFromNumber(steg) ?? resumeStep(s) ?? "klart");

  return (
    <Onboarding
      org={{
        id,
        name: org.name,
        logoUpdatedAt: org.logo_updated_at ?? null,
        folderSet: Boolean(org.meeting_folder_id),
        folderName: org.meeting_folder_name ?? null,
        profile: { about: org.about ?? null, website_url: org.website_url ?? null, facebook_url: org.facebook_url ?? null, instagram_url: org.instagram_url ?? null },
      }}
      initialStep={step}
      state={s}
      board={boardRows(people, members)}
      inviteUrl={`${appOrigin()}/join/${org.invite_code}`}
      myEmail={user.data.user?.email?.toLowerCase() ?? null}
      invites={invites}
      inviterName={inviterNameFor(people.find((x) => x.member_user_id === user.data.user?.id)?.name, user.data.user?.user_metadata)}
      pickerEnabled={pickerEnabled(getEnv())}
      format={{ kind: format.id ? format.profile.kind : null, name: format.profile.kind === "learned" ? "ert eget format" : FORMAT_NAMES[format.profile.kind], profile: format.id ? format.profile : null }}
      stadgarSaved={Boolean(org.arsmote_format_id)}
      historyCount={history.count}
    />
  );
}
