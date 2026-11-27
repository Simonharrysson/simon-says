import { requestCalendarAccess, saveOrgCalendarResult } from "@/app/(app)/calendar-actions";
import { isNow, orgCalendarChoices, stockholmDateTime } from "@/lib/calendar/events";
import { myCalendars, orgUpcoming, safeCalendarConnected, type OrgCalendar, type UpcomingState } from "@/lib/calendar/load";
import { CalendarUpcoming, type StartCalendar } from "./CalendarUpcoming";
import { OrgCalendarForm } from "./OrgCalendarForm";

// Server components that read Google (todo #14). The förening page renders them inside <Suspense>,
// so a slow Google never holds up the page: they stream in when ready (or show nothing).

/** The start card's calendar part from an upcoming state. Undefined: no calendar chosen. */
export function startCalendar(upcoming: UpcomingState, now = new Date()): StartCalendar | undefined {
  if (upcoming.state === "none") return undefined;
  if (upcoming.state === "disconnected") return { state: "disconnected", connect: requestCalendarAccess };
  if (upcoming.state === "unavailable") return { state: "unavailable" };
  return {
    state: "ok",
    events: upcoming.events.map((e) => ({ id: e.id, title: e.title, ...stockholmDateTime(e.start), now: isNow(e, now) })),
  };
}

/** Starta möte: the next events of the förening's calendar, with the viewer's own grant. */
export async function StartCalendarSlot({ orgId, userId, org }: { orgId: string; userId: string; org: OrgCalendar }) {
  const calendar = startCalendar(await orgUpcoming(userId, org));
  return calendar ? <CalendarUpcoming orgId={orgId} calendar={calendar} /> : null;
}

/** Inställningar → Mötenas kalender (admins): their own shared calendars to choose from. */
export async function OrgCalendarSlot({ orgId, userId, org }: { orgId: string; userId: string; org: OrgCalendar }) {
  const connected = await safeCalendarConnected(userId);
  const calendars = connected ? await myCalendars(userId) : null;
  return (
    <OrgCalendarForm
      orgId={orgId}
      connected={connected}
      calendars={calendars ? orgCalendarChoices(calendars).map((c) => ({ id: c.id, name: c.name })) : null}
      current={{ id: org.calendar_id ?? null, name: org.calendar_name ?? null, filter: org.calendar_filter ?? null }}
      save={saveOrgCalendarResult}
      connect={requestCalendarAccess}
    />
  );
}
