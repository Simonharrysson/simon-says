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
import { AiConnections } from "@/components/views/AiConnections";
import { canCreateForetag } from "@/lib/foretag/gate";
import { loadConnections } from "@/lib/mcp/account";
import { mcpConfigured } from "@/lib/mcp/deps";
import { resourceUri } from "@/lib/mcp/oauth";
import { appOrigin } from "@/lib/origin";
import { revokeConnectionAction, saveEmailPrefsAction, saveLocaleAction } from "./actions";

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
  const [emailPrefs, { fel, kalender }, calendarConnected, ai] = await Promise.all([
    loadEmailPrefs({ userId: user.id }),
    searchParams,
    safeCalendarConnected(user.id),
    loadConnections(db),
  ]);
  // Kopplade AI-assistenter: for the allow-list (spec "Gate"), and for anyone who still has a connection.
  const showAi = mcpConfigured() && (canCreateForetag(user.email) || ai.connections.length > 0);
  return (
    <AccountView
      email={user.email ?? ""}
      signOut={signOut}
      emailPrefs={emailPrefs}
      saveEmailPrefs={saveEmailPrefsAction}
      saveLocale={saveLocaleAction}
      localeFailed={fel === "sprak"}
      ai={
        showAi ? (
          <AiConnections
            connections={ai.connections}
            audit={ai.audit}
            revoke={revokeConnectionAction}
            revokeFailed={fel === "aterkalla"}
            mcpUrl={resourceUri(appOrigin())}
          />
        ) : undefined
      }
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
