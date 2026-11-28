import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { signInWithGoogle, switchAccount } from "@/app/login/actions";
import { InviteBeacon } from "@/components/views/InviteBeacon";
import { InviteInvalidView, InviteLandingView, type InviteLandingState } from "@/components/views/InviteLandingView";
import { PublicShell } from "@/components/views/PublicShell";
import { loadInvite } from "@/lib/growth/claim";
import { isLocale, defaultLocale } from "@/lib/i18n/config";
import { dayMonth } from "@/lib/summaries/email";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("join.meetingInvite"))("metaTitle"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

/**
 * The invite's landing (0067). Opening it never claims anything (a GET); "Fortsätt med Google"
 * signs in and returns to /in/<token>/klar, which claims for the invited address only.
 */
export default async function InviteLandingPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ fel?: string }> }) {
  const [{ token }, { fel }] = await Promise.all([params, searchParams]);
  const db = await createSupabaseServerClient();
  const [{ data }, invite] = await Promise.all([db.auth.getUser(), loadInvite(token).catch(() => null)]);
  const user = data.user;
  if (!invite) {
    return (
      <PublicShell signedIn={Boolean(user)}>
        <InviteInvalidView />
      </PublicShell>
    );
  }
  const localeRaw = await getLocale();
  const locale = isLocale(localeRaw) ? localeRaw : defaultLocale;
  const t = await getTranslations("join.meetingInvite");
  const userEmail = (user?.email ?? "").trim().toLowerCase();
  // Already claimed by this account: straight to the meeting.
  if (user && invite.claimedBy === user.id && !fel) redirect(`/orgs/${invite.orgId}/mote/${invite.meetingId}`);
  let view: InviteLandingState;
  if (fel === "borta") view = { state: "gone" };
  else if (fel === "fel") view = { state: "error" };
  else if (invite.claimedBy && invite.claimedBy !== user?.id) view = { state: "used" };
  else if (invite.expired) view = { state: "expired", signedIn: Boolean(user) };
  else if (!user) view = { state: "signed-out" };
  else if (userEmail !== invite.email) view = { state: "mismatch", current: user.email ?? "" };
  else view = { state: "ready", email: user.email ?? "" };
  return (
    <PublicShell signedIn={Boolean(user)}>
      <InviteBeacon token={token} />
      <InviteLandingView
        token={token}
        orgName={invite.orgName}
        title={invite.title ?? t("fallbackTitle", { date: dayMonth(invite.startedAt, locale) })}
        starterName={invite.starterName}
        maskedEmail={invite.maskedEmail}
        view={view}
        signIn={signInWithGoogle}
        switchAccount={switchAccount}
      />
    </PublicShell>
  );
}
