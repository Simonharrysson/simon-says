import { isForetagOrg } from "@/lib/foretag/guard";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { Onboarding } from "@/components/onboarding/Onboarding";
import { isUuid } from "@/lib/db/ids";
import { orgMemberList, type OrgMember } from "@/lib/db/members";
import { getOrg, listPeople, myRole } from "@/lib/db/orgs";
import { getEnv, pickerEnabled } from "@/lib/env";
import { FormatCard } from "@/components/views/FormatCard";
import { formatName } from "@/lib/formats/standard";
import { listOrgFormats, orgDefaultFormat } from "@/lib/formats/store";
import { historySummary } from "@/lib/history/store";
import { loadOnboarding } from "@/lib/onboarding/store";
import { resumeStep, stepFromNumber, type OnboardingState } from "@/lib/onboarding/steps";
import { orgTabHref } from "@/lib/orgs/tabs";
import { changeFormatAction } from "../../actions";
import { appOrigin } from "@/lib/origin";
import { boardRows } from "@/lib/people/board";
import type { InviteRow } from "@/lib/invites/rules";
import { inviterNameFor, listInvites } from "@/lib/invites/send";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { orgDriveAccount } from "@/lib/google/drive-account";
import { driveAccountView, driveResultOf, memberNames } from "@/lib/google/drive-account-rules";
import { blockedRevocationCount } from "@/lib/foretag/reconcile";
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
 * Once an admin has hidden it ("Fortsätt senare" on the card) it is gone: every setting it touched
 * lives in Inställningar, so the link leads there.
 */
export default async function OnboardingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ steg?: string; drivekonto?: string }> }) {
  const { id } = await params;
  const { steg, drivekonto } = await searchParams;
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
  const locale = await getLocale();
  const [state, people, members, format, formats, history, user, invites, driveAccount, stuckShares] = await Promise.all([
    loadOnboarding(db, id),
    listPeople(db, id),
    orgMemberList(id).catch((): OrgMember[] => []),
    orgDefaultFormat(db, id),
    listOrgFormats(db, id),
    historySummary(db, id).catch(() => ({ count: 0 })),
    db.auth.getUser(),
    listInvites(supabaseAdmin(), id).catch((): InviteRow[] => []),
    // Service role, after the admin check: the förening's Drive account (never its token).
    orgDriveAccount(id).catch(() => null),
    blockedRevocationCount(id),
  ]);
  if (state?.dismissedAt) redirect(orgTabHref(id, "installningar"));
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
      driveAccount={driveAccountView(driveAccount, user.data.user?.id ?? "", org.meeting_folder_id ?? null, memberNames(people, members))}
      stuckShares={stuckShares}
      driveResult={driveResultOf(drivekonto)}
      formatCard={
        // Nothing saved yet: the card shows the Veckomöte that Fortsätt makes (as the step did).
        <FormatCard
          orgId={id}
          current={
            format.id
              ? { kind: format.profile.kind, name: formatName(format.profile.kind, locale), id: format.id, profile: format.profile }
              : { kind: "veckomote", name: formatName("veckomote", locale) }
          }
          isAdmin
          formats={formats}
          changeFormat={changeFormatAction}
          pickerEnabled={pickerEnabled(getEnv())}
        />
      }
      historyCount={history.count}
    />
  );
}
