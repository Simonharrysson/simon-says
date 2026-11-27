import "server-only";
import { foretagEventById } from "@/lib/calendar/load";
import { audienceIds, customerForDomain } from "@/lib/db/foretag";
import { orgMemberList, type OrgMember } from "@/lib/db/members";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { customerDomain, customerName, ownDomains } from "./customers";
import { attendeeIdsFor } from "./attendees";

// The Företag part of a meeting start (0050): which group the meeting is for, whether it is a
// Privat möte, who attends, the customer, and who the new Doc may be shared with (exactly the
// accounts that will see the meeting).
//
// Attendees give access (even to a Privat möte), so nothing is attached automatically: only when
// the starter confirmed the calendar event ("Koppla till kalenderhändelsen?") is it read again,
// and only the colleagues they ticked who are really on its guest list (and members) attend. No
// confirmed event: no title, no attendees, no customer. A Privat möte never gets a customer.
// Nothing from the calendar is stored but the customer's domain.

export interface ForetagStart {
  groupId: string | null;
  private: boolean;
  /** Accounts known to attend (starter first), for meeting_attendees. */
  attendees: { userId: string; source: "starter" | "calendar" }[];
  customerId: string | null;
  eventTitle: string | null;
  /** Accounts that will see the meeting: the Doc is shared only with these. */
  viewers: Set<string>;
  members: OrgMember[];
}

export type ForetagStartResult = { ok: true; plan: ForetagStart } | { ok: false; error: "bad_group" };

export async function planForetagStart(input: {
  orgId: string;
  user: { id: string; email?: string | null };
  groupId: string | null | undefined;
  private: boolean | undefined;
  /** The calendar event the starter confirmed (their primary calendar), if any. */
  calendarEventId?: string | null;
  /** The colleagues the starter ticked as attending (must be on the event's guest list). */
  attendeeIds?: string[];
  /** Testmöte and other server starts skip the calendar. */
  readCalendar: boolean;
}): Promise<ForetagStartResult> {
  const groupId = input.groupId ?? null;
  if (groupId) {
    const { data, error } = await supabaseAdmin()
      .from("groups")
      .select("id")
      .eq("id", groupId)
      .eq("org_id", input.orgId)
      .is("archived_at", null)
      .maybeSingle();
    if (error) throw new Error(`foretag start: group: ${error.message}`);
    if (!data) return { ok: false, error: "bad_group" };
  }
  const priv = input.private === true;
  const [members, event] = await Promise.all([
    orgMemberList(input.orgId),
    input.readCalendar && input.calendarEventId ? foretagEventById(input.user.id, input.calendarEventId) : Promise.resolve(null),
  ]);
  const guests = event ? event.guests.map((g) => g.email) : [];
  const onEvent = new Set(attendeeIdsFor(guests, members));
  const ticked = new Set(input.attendeeIds ?? []);
  const attendees: ForetagStart["attendees"] = [
    { userId: input.user.id, source: "starter" },
    ...[...onEvent].filter((id) => id !== input.user.id && ticked.has(id)).map((userId) => ({ userId, source: "calendar" as const })),
  ];
  const domain = event && !priv ? customerDomain(guests, ownDomains(members.map((m) => m.email))) : null;
  const customerId = domain ? await customerForDomain(input.orgId, domain, customerName(domain)) : null;
  const viewers = new Set(
    await audienceIds(
      input.orgId,
      groupId,
      priv,
      input.user.id,
      attendees.map((a) => a.userId),
    ),
  );
  return { ok: true, plan: { groupId, private: priv, attendees, customerId, eventTitle: event?.title || null, viewers, members } };
}

/** After the start stands: who attended (best effort; the starter is visible as starter anyway). */
export async function saveAttendees(meetingId: string, attendees: ForetagStart["attendees"]): Promise<void> {
  if (!attendees.length) return;
  const { error } = await supabaseAdmin()
    .from("meeting_attendees")
    .upsert(
      attendees.map((a) => ({ meeting_id: meetingId, user_id: a.userId, source: a.source })),
      { onConflict: "meeting_id,user_id", ignoreDuplicates: true },
    );
  if (error) console.error(`meetings ${meetingId}: attendees not saved: ${error.message}`);
}
