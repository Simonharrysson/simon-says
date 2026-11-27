import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { signOut } from "@/app/login/actions";
import { AccountView } from "@/components/views/AccountView";
import { CalendarConnect } from "@/components/calendar/CalendarConnect";
import { calendarResult } from "@/lib/calendar/events";
import { safeCalendarConnected } from "@/lib/calendar/load";
import { disconnectCalendar, requestCalendarAccess } from "../calendar-actions";
import { loadEmailPrefs } from "@/lib/email/prefs";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadMyBriefForeningar } from "@/lib/brief/prefs";
import { saveBriefForeningarAction, saveEmailPrefsAction, saveLocaleAction } from "./actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("account"))("metaTitle") };
}

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ fel?: string; kalender?: string }> }) {
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");
  const [emailPrefs, { fel, kalender }, calendarConnected, briefForeningar] = await Promise.all([
    loadEmailPrefs({ userId: user.id }),
    searchParams,
    safeCalendarConnected(user.id),
    loadMyBriefForeningar(db, user.id),
  ]);
  return (
    <AccountView
      email={user.email ?? ""}
      signOut={signOut}
      emailPrefs={emailPrefs}
      saveEmailPrefs={saveEmailPrefsAction}
      briefForeningar={{ initial: briefForeningar, save: saveBriefForeningarAction }}
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
