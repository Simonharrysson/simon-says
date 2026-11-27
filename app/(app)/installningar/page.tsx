import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { signOut } from "@/app/login/actions";
import { AccountColumn, AccountView } from "@/components/views/AccountView";
import { CalendarConnect } from "@/components/calendar/CalendarConnect";
import { PageHeader } from "@/components/ui/PageHeader";
import { SkeletonPanel } from "@/components/ui/PageSkeleton";
import { calendarResult } from "@/lib/calendar/events";
import { safeCalendarConnected } from "@/lib/calendar/load";
import { disconnectCalendar, requestCalendarAccess } from "../calendar-actions";
import { loadEmailPrefs } from "@/lib/email/prefs";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { saveEmailPrefsAction, saveLocaleAction } from "./actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("account"))("metaTitle") };
}

type Search = Promise<{ fel?: string; kalender?: string }>;

/** Konto: the title is in the first HTML (it is the page's largest text); the panels stream in. */
export default async function AccountPage({ searchParams }: { searchParams: Search }) {
  const t = await getTranslations("account");
  return (
    <AccountColumn>
      <PageHeader title={t("title")} />
      <Suspense fallback={<AccountSkeleton />}>
        <AccountPanels searchParams={searchParams} />
      </Suspense>
    </AccountColumn>
  );
}

async function AccountPanels({ searchParams }: { searchParams: Search }) {
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");
  const [emailPrefs, { fel, kalender }, calendarConnected] = await Promise.all([
    loadEmailPrefs({ userId: user.id }),
    searchParams,
    safeCalendarConnected(user.id),
  ]);
  return (
    <AccountView
      bare
      email={user.email ?? ""}
      signOut={signOut}
      emailPrefs={emailPrefs}
      saveEmailPrefs={saveEmailPrefsAction}
      saveLocale={saveLocaleAction}
      localeFailed={fel === "sprak"}
      calendar={
        <CalendarConnect
          connected={calendarConnected}
          connect={requestCalendarAccess}
          disconnect={disconnectCalendar}
          back="/installningar"
          result={calendarResult(kalender)}
        />
      }
    />
  );
}

/** The panels' places while they load: Inloggad som, Språk, Mejl, Kalender. */
function AccountSkeleton() {
  return (
    <>
      <SkeletonPanel height="h-12" titleWidth="w-36" />
      <SkeletonPanel height="h-32" titleWidth="w-20" />
      <SkeletonPanel height="h-72" titleWidth="w-16" />
      <SkeletonPanel height="h-24" titleWidth="w-24" />
    </>
  );
}
