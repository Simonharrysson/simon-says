import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import type { MailMessage } from "@/lib/mail";

// The growth loop (0067) against the real schema, with a fake mailer (no e-mail leaves):
// the invite list replaces the summary for attendees without an account, the per-meeting guest
// grant (RLS: only that meeting, never a private one, revocable by admins, the shared visibility
// functions not widened), the claim (only the invited address, single use), the one reminder.
// Fictional data.

vi.mock("@/lib/supabase/admin", async () => ({ supabaseAdmin: (await import("@/test/local-supabase")).adminClient }));
vi.mock("@/lib/env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/env")>();
  const { testEnv } = await import("@/test/env");
  const env = mod.parseEnv({ ...testEnv, APP_URL: "https://app.test" });
  return { ...mod, getEnv: () => env };
});

const { createOrg, joinOrg } = await import("@/lib/db/orgs");
const { sendMeetingSummaries } = await import("@/lib/summaries/send");
const { sendQueuedInvites, sendInviteReminders, sendPendingInvites, trySendMeetingInvites } = await import("@/lib/growth/send");
const { claimInvite, loadInvite } = await import("@/lib/growth/claim");
const { inviteToken } = await import("@/lib/growth/token");

function fakeMailer() {
  const sent: MailMessage[] = [];
  return { sent, mailer: { send: async (m: MailMessage) => (sent.push(m), true) }, now: () => new Date(), sleep: async () => {} };
}

/** The next 12:00 Stockholm (a reminder hour), within a day of now. */
function noonStockholm(): Date {
  const d = new Date();
  d.setUTCHours(11, 0, 0, 0);
  return d;
}

describe.skipIf(!hasLocalSupabase)("growth loop (0067)", () => {
  let admin: TestUser;
  let member: TestUser;
  let guest: TestUser;
  let other: TestUser;
  let orgId: string;
  const db = () => adminClient();
  const ids = { oskar: "", karin: "", nils: "" };

  async function person(name: string, over: Record<string, unknown> = {}): Promise<string> {
    const { data, error } = await db().from("people").insert({ org_id: orgId, name, ...over }).select("id").single();
    if (error) throw new Error(error.message);
    return data.id as string;
  }

  /** A finished meeting with a decision and Oskar's task; the calendar expected Oskar, Karin and Nils. */
  async function meeting(over: Record<string, unknown> = {}): Promise<string> {
    const { data, error } = await db()
      .from("meetings")
      .insert({
        org_id: orgId,
        started_by: admin.id,
        doc_id: `doc-${randomUUID()}`,
        notes_tab_id: "t",
        status: "done",
        ended_at: new Date().toISOString(),
        calendar_event: { title: "Styrelsemöte november", expected: [ids.oskar, ids.karin, ids.nils], declined: [] },
        ...over,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const id = data.id as string;
    const rows = [
      { meeting_id: id, id: "n1", section: "decision", kind: "decision", text: "Vårstädningen blir 18 april", position: 0 },
      { meeting_id: id, id: "n2", section: "action", kind: "task", text: "Boka bryggan", owner: "Oskar Ek", position: 1 },
    ];
    expect((await db().from("note_items").insert(rows)).error).toBeNull();
    return id;
  }

  async function addGuest(meetingId: string, email: string, name = "Gäst Gästsson") {
    expect((await db().from("meeting_calendar_guests").insert({ meeting_id: meetingId, email, name, response: "accepted" })).error).toBeNull();
  }

  async function invite(meetingId: string, email: string) {
    const { data } = await db().from("meeting_invites").select("*").eq("meeting_id", meetingId).eq("email", email).maybeSingle();
    return data as { id: string; status: string; person_id: string | null; sent_at: string | null; claimed_by: string | null; reminder_status: string | null } | null;
  }

  /** A Google identity, as a real sign-in has (the claim requires one; the seed's test function). */
  const google = async (u: TestUser) => expect((await db().rpc("test_add_google_identity", { p_user: u.id })).error).toBeNull();

  beforeAll(async () => {
    [admin, member, guest, other] = await Promise.all([createTestUser("gl-adm"), createTestUser("gl-mem"), createTestUser("gl-guest"), createTestUser("gl-other")]);
    const r = await createOrg(admin.db, "Tillväxtföreningen");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
    const { data } = await db().from("orgs").select("invite_code").eq("id", orgId).single();
    expect(await joinOrg(member.db, data!.invite_code as string)).toBe(orgId);
    await person("Johanna Lind", { member_user_id: admin.id });
    ids.oskar = await person("Oskar Ek", { email: `oskar-${randomUUID().slice(0, 6)}@exempel.se` });
    ids.karin = await person("Karin Sjö", { member_user_id: member.id, email: "karin@exempel.se" });
    ids.nils = await person("Nils Utanadress");
    await db().from("orgs").update({ summary_mode: "all" }).eq("id", orgId);
  });

  it("the ledger and the grants are server-only; the funnel too", async () => {
    expect((await admin.db.from("meeting_invites").select("id")).error).not.toBeNull();
    expect((await admin.db.from("meeting_calendar_guests").select("email")).error).not.toBeNull();
    expect((await admin.db.from("meeting_invite_funnel").select("sent")).error).not.toBeNull();
    expect((await admin.db.from("meeting_guests").insert({ meeting_id: randomUUID(), user_id: admin.id, email: "x@y.se" })).error).not.toBeNull();
  });

  it("attendees without an account get the invite instead of the summary; accounts keep the summary", async () => {
    const id = await meeting();
    await addGuest(id, guest.email.toLowerCase());
    const f = fakeMailer();
    await sendMeetingSummaries(id, f);
    const oskarEmail = ((await db().from("people").select("email").eq("id", ids.oskar).single()).data!.email as string).toLowerCase();
    // Queued before anything is sent: Oskar (people row, no account) and the calendar guest. The
    // guest has an account (createTestUser) — so only Oskar is queued; Karin is linked; Nils has no address.
    const rows = (await db().from("meeting_invites").select("email, person_id, status, source").eq("meeting_id", id)).data!;
    expect(rows).toEqual([{ email: oskarEmail, person_id: ids.oskar, status: "queued", source: "calendar" }]);
    // The summary went to the accounts (admin and Karin) and never to Oskar.
    expect(f.sent.map((m) => m.to)).not.toContain(oskarEmail);
    expect(f.sent.length).toBeGreaterThan(0);
    const ev = (await db().from("meeting_events").select("detail").eq("meeting_id", id).eq("kind", "invites")).data!;
    expect(ev[0].detail).toMatchObject({ state: "queued", queued: 1, withoutEmail: 1 });
    expect(JSON.stringify(ev)).not.toMatch(/exempel|Oskar/i);

    const inv = fakeMailer();
    expect(await sendQueuedInvites(inv, { meetingId: id })).toBe(1);
    expect(inv.sent.map((m) => m.to)).toEqual([oskarEmail]);
    expect(inv.sent[0].subject).toBe('Johanna bjöd in dig till "Styrelsemöte november"');
    expect(inv.sent[0].text).toContain("Boka bryggan");
    expect(inv.sent[0].idempotencyKey).toMatch(/^inv-/);
    expect(inv.sent[0].fromName).toBe("Johanna via Simon Says");
    // Never twice.
    expect(await sendQueuedInvites(inv, { meetingId: id })).toBe(0);
    expect((await invite(id, oskarEmail))!.status).toBe("sent");
  });

  it("an address that said no to invites keeps its summary as before", async () => {
    const no = `nej-${randomUUID().slice(0, 6)}@exempel.se`;
    const pid = await person("Nej Nilsson", { email: no });
    expect((await db().from("email_address_preferences").insert({ email: no, all_off: false, off_categories: ["meeting_invite"] })).error).toBeNull();
    const id = await meeting({ calendar_event: { title: "Styrelsemöte november", expected: [pid], declined: [] } });
    const f = fakeMailer();
    await sendMeetingSummaries(id, f);
    expect((await invite(id, no))!.status).toBe("skipped");
    expect(f.sent.map((m) => m.to)).toContain(no);
  });

  describe("an invite that doesn't go out after all: the summary instead, once", () => {
    /** A meeting whose only expected attendee is a fresh person without an account (mode all: a summary recipient). */
    async function setup() {
      const email = `fb-${randomUUID().slice(0, 8)}@exempel.se`;
      const pid = await person(`Reserv ${email.slice(3, 9)}`, { email });
      const id = await meeting({ calendar_event: { title: "Styrelsemöte november", expected: [pid], declined: [] } });
      const first = fakeMailer();
      await sendMeetingSummaries(id, first);
      expect(first.sent.map((m) => m.to)).not.toContain(email);
      expect((await db().from("meeting_invites").select("status, summary_fallback").eq("meeting_id", id).eq("email", email).single()).data).toEqual({ status: "queued", summary_fallback: true });
      return { id, email };
    }
    const summariesTo = (f: ReturnType<typeof fakeMailer>, email: string) => f.sent.filter((m) => m.to === email && m.subject.startsWith("Sammanfattning:"));

    it("an account was made meanwhile (skipped at send time)", async () => {
      const { id, email } = await setup();
      expect((await db().auth.admin.createUser({ email, email_confirm: true })).error).toBeNull();
      const f = fakeMailer();
      await trySendMeetingInvites(id, f);
      expect((await invite(id, email))!.status).toBe("skipped");
      expect(summariesTo(f, email)).toHaveLength(1);
      expect(summariesTo(f, email)[0].idempotencyKey).toMatch(/^sum-/);
      // Never twice: the meeting's hook and the cron again.
      await trySendMeetingInvites(id, f);
      await sendPendingInvites(f, { orgId });
      expect(summariesTo(f, email)).toHaveLength(1);
    });

    it("the förening turned the invites off before they went", async () => {
      const { id, email } = await setup();
      await db().from("orgs").update({ invite_attendees: false }).eq("id", orgId);
      const f = fakeMailer();
      try {
        await trySendMeetingInvites(id, f);
      } finally {
        await db().from("orgs").update({ invite_attendees: true }).eq("id", orgId);
      }
      expect((await invite(id, email))!.status).toBe("skipped");
      expect(f.sent.map((m) => m.to)).toEqual([email]);
      expect(summariesTo(f, email)).toHaveLength(1);
    });

    it("the provider refused the invite (failed)", async () => {
      const { id, email } = await setup();
      const sent: MailMessage[] = [];
      const f = { sent, mailer: { send: async (m: MailMessage) => (sent.push(m), !m.subject.includes("bjöd in")) }, now: () => new Date(), sleep: async () => {} };
      await trySendMeetingInvites(id, f);
      expect((await invite(id, email))!.status).toBe("failed");
      expect(summariesTo(f, email)).toHaveLength(1);
    });

    it("the queued invite aged out (never sent late)", async () => {
      const { id, email } = await setup();
      await db().from("meeting_invites").update({ created_at: new Date(Date.now() - 3 * 86_400_000).toISOString() }).eq("meeting_id", id);
      const f = fakeMailer();
      await sendPendingInvites(f, { orgId });
      expect((await db().from("meeting_invites").select("status, skip_reason").eq("meeting_id", id).eq("email", email).single()).data).toEqual({ status: "skipped", skip_reason: "expired" });
      expect(f.sent.filter((m) => m.to === email).map((m) => m.subject.startsWith("Sammanfattning:"))).toEqual([true]);
      await sendPendingInvites(f, { orgId });
      expect(summariesTo(f, email)).toHaveLength(1);
    });

    it("an invite that went out gets no summary", async () => {
      const { id, email } = await setup();
      const f = fakeMailer();
      await trySendMeetingInvites(id, f);
      expect((await invite(id, email))!.status).toBe("sent");
      expect(f.sent.filter((m) => m.to === email).map((m) => m.subject)).toEqual(['Johanna bjöd in dig till "Styrelsemöte november"']);
    });
  });

  it("the starter's toggle at Starta turns it off for that meeting", async () => {
    const id = await meeting({ invite_attendees: false });
    await sendMeetingSummaries(id, fakeMailer());
    expect((await db().from("meeting_invites").select("id").eq("meeting_id", id)).data).toEqual([]);
  });

  it("never for a private meeting", async () => {
    const id = await meeting({ private: true });
    await sendMeetingSummaries(id, fakeMailer());
    expect((await db().from("meeting_invites").select("id").eq("meeting_id", id)).data).toEqual([]);
  });

  describe("the guest grant", () => {
    let meetingId: string;
    let otherMeeting: string;
    let token: string;
    const guestEmail = () => guest.email.toLowerCase();

    beforeAll(async () => {
      meetingId = await meeting();
      otherMeeting = await meeting();
      // A calendar guest outside the list, invited (written as the queue does).
      const { data, error } = await db()
        .from("meeting_invites")
        .insert({ meeting_id: meetingId, org_id: orgId, email: guestEmail(), name: "Gäst Gästsson", source: "calendar", status: "sent", sent_at: new Date().toISOString() })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      token = inviteToken(data.id as string, guestEmail());
    });

    it("without a Google identity even the invited address can't claim (e-mail sign-up can't bypass the binding)", async () => {
      expect((await claimInvite(token, { id: guest.id })).outcome).toBe("mismatch");
      expect((await loadInvite(token))!.claimedBy).toBeNull();
      await google(guest);
      await google(other);
    });

    it("before the claim the guest sees nothing", async () => {
      expect((await guest.db.from("meetings").select("id").eq("id", meetingId)).data).toEqual([]);
    });

    it("a forwarded link: another account's claim is refused and takes nothing", async () => {
      expect((await claimInvite(token, { id: other.id })).outcome).toBe("mismatch");
      expect((await other.db.from("meetings").select("id").eq("id", meetingId)).data).toEqual([]);
      expect((await loadInvite(token))!.claimedBy).toBeNull();
      // A token signed for another address never matches.
      expect((await claimInvite(inviteToken((await loadInvite(token))!.id, other.email), { id: other.id })).outcome).toBe("invalid");
    });

    it("the invited address claims: that meeting and its notes only, no membership", async () => {
      expect(await claimInvite(token, { id: guest.id })).toEqual({ outcome: "ok", orgId, meetingId });
      expect((await guest.db.from("meetings").select("id").eq("id", meetingId)).data).toEqual([{ id: meetingId }]);
      expect((await guest.db.from("note_items").select("id").eq("meeting_id", meetingId)).data!.length).toBe(2);
      // Not the förening's other meeting, its notes, its row, its people or its members.
      expect((await guest.db.from("meetings").select("id").eq("org_id", orgId)).data).toEqual([{ id: meetingId }]);
      expect((await guest.db.from("note_items").select("id").eq("meeting_id", otherMeeting)).data).toEqual([]);
      expect((await guest.db.from("orgs").select("id").eq("id", orgId)).data).toEqual([]);
      expect((await guest.db.from("people").select("id").eq("org_id", orgId)).data).toEqual([]);
      expect((await db().from("org_members").select("user_id").eq("org_id", orgId).eq("user_id", guest.id)).data).toEqual([]);
      // The shared visibility functions are not widened: no events or speakers of that meeting.
      expect((await guest.db.from("meeting_events").select("id").eq("meeting_id", meetingId)).data).toEqual([]);
      expect((await guest.db.rpc("can_see_meeting", { p_meeting_id: meetingId })).data).toBe(false);
      // Single use: someone else now gets "used"; the same account again is fine.
      expect((await claimInvite(token, { id: other.id })).outcome).toBe("used");
      expect((await claimInvite(token, { id: guest.id })).outcome).toBe("ok_again");
      // Admins see the grant (the attendee list); members don't.
      expect((await admin.db.from("meeting_guests").select("user_id").eq("meeting_id", meetingId)).data).toEqual([{ user_id: guest.id }]);
      expect((await member.db.from("meeting_guests").select("user_id").eq("meeting_id", meetingId)).data).toEqual([]);
    });

    it("never a private meeting: making it private drops the guest at once", async () => {
      await db().from("meetings").update({ private: true }).eq("id", meetingId);
      expect((await guest.db.from("meetings").select("id").eq("id", meetingId)).data).toEqual([]);
      expect((await guest.db.from("note_items").select("id").eq("meeting_id", meetingId)).data).toEqual([]);
      await db().from("meetings").update({ private: false }).eq("id", meetingId);
      expect((await guest.db.from("meetings").select("id").eq("id", meetingId)).data).toEqual([{ id: meetingId }]);
    });

    it("revocable by admins only; a repeat claim never gives it back", async () => {
      expect((await member.db.rpc("set_meeting_guest_access", { p_meeting_id: meetingId, p_user_id: guest.id, p_on: false })).data).toBe(false);
      expect((await guest.db.from("meetings").select("id").eq("id", meetingId)).data).toEqual([{ id: meetingId }]);
      expect((await admin.db.rpc("set_meeting_guest_access", { p_meeting_id: meetingId, p_user_id: guest.id, p_on: false })).data).toBe(true);
      expect((await guest.db.from("meetings").select("id").eq("id", meetingId)).data).toEqual([]);
      expect((await claimInvite(token, { id: guest.id })).outcome).toBe("ok_again");
      expect((await guest.db.from("meetings").select("id").eq("id", meetingId)).data).toEqual([]);
      expect((await admin.db.rpc("set_meeting_guest_access", { p_meeting_id: meetingId, p_user_id: guest.id, p_on: true })).data).toBe(true);
      expect((await guest.db.from("meetings").select("id").eq("id", meetingId)).data).toEqual([{ id: meetingId }]);
    });

    it("a claim on a meeting made private is refused (gone)", async () => {
      const id = await meeting({ private: true });
      const { data } = await db()
        .from("meeting_invites")
        .insert({ meeting_id: id, org_id: orgId, email: other.email.toLowerCase(), source: "calendar", status: "sent", sent_at: new Date().toISOString() })
        .select("id")
        .single();
      expect((await claimInvite(inviteToken(data!.id as string, other.email), { id: other.id })).outcome).toBe("gone");
      expect((await db().from("meeting_guests").select("user_id").eq("meeting_id", id)).data).toEqual([]);
    });
  });

  it("a people row's claim links the row and joins the förening", async () => {
    const newbie = await createTestUser("gl-new");
    await google(newbie);
    const pid = await person("Ny Nilsson", { email: newbie.email.toLowerCase() });
    const id = await meeting();
    const { data } = await db()
      .from("meeting_invites")
      .insert({ meeting_id: id, org_id: orgId, person_id: pid, email: newbie.email.toLowerCase(), source: "name_round", status: "sent", sent_at: new Date().toISOString() })
      .select("id")
      .single();
    const res = await claimInvite(inviteToken(data!.id as string, newbie.email), { id: newbie.id, created_at: new Date().toISOString() });
    expect(res.outcome).toBe("ok");
    expect((await db().from("people").select("member_user_id").eq("id", pid).single()).data!.member_user_id).toBe(newbie.id);
    expect((await db().from("org_members").select("role").eq("org_id", orgId).eq("user_id", newbie.id).single()).data!.role).toBe("member");
    expect((await db().from("meeting_invites").select("claim_kind").eq("id", data!.id).single()).data!.claim_kind).toBe("new_account");
    expect((await db().from("meeting_guests").select("user_id").eq("meeting_id", id)).data).toEqual([]);
  });

  it("one reminder, only if not clicked, never twice; the funnel counts", async () => {
    const id = await meeting();
    const now = noonStockholm();
    const sentAt = new Date(now.getTime() - 3 * 86_400_000).toISOString();
    const fresh = `rem-${randomUUID().slice(0, 6)}@exempel.se`;
    const clicked = `klick-${randomUUID().slice(0, 6)}@exempel.se`;
    expect(
      (
        await db()
          .from("meeting_invites")
          .insert([
            { meeting_id: id, org_id: orgId, email: fresh, source: "calendar", status: "sent", sent_at: sentAt },
            { meeting_id: id, org_id: orgId, email: clicked, source: "calendar", status: "sent", sent_at: sentAt, clicked_human_at: sentAt },
          ])
      ).error,
    ).toBeNull();
    const f = { ...fakeMailer(), now: () => now };
    expect(await sendInviteReminders(f, { orgId })).toBe(1);
    expect(f.sent.map((m) => m.to)).toEqual([fresh]);
    expect(f.sent[0].subject).toMatch(/^\(Påminnelse\) /);
    expect(f.sent[0].idempotencyKey).toMatch(/-r$/);
    expect(await sendInviteReminders(f, { orgId })).toBe(0);
    expect(f.sent).toHaveLength(1);
    const funnel = (await db().from("meeting_invite_funnel").select("sent, reminded, clicked_human, signed_up").eq("meeting_id", id).single()).data;
    expect(funnel).toEqual({ sent: 2, reminded: 1, clicked_human: 1, signed_up: 0 });
  });

  it("the tree rule: a förening with groups only invites people placed to see the meeting", async () => {
    const { data: rows } = await db().rpc("person_may_see_meeting", { p_person_id: ids.oskar, p_meeting_id: await meeting() });
    expect(rows).toBe(true);
    const priv = await meeting({ private: true });
    expect((await db().rpc("person_may_see_meeting", { p_person_id: ids.oskar, p_meeting_id: priv })).data).toBe(false);
  });
});
