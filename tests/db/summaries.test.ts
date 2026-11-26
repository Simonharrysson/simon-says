import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import type { MailMessage } from "@/lib/mail";

// 0037: the summary setting (admins only, through set_summary_settings), the guard on people's
// summary columns, and the sender against the real schema with a fake mailer (no e-mail leaves).

vi.mock("@/lib/supabase/admin", async () => ({ supabaseAdmin: (await import("@/test/local-supabase")).adminClient }));
vi.mock("@/lib/env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/env")>();
  const { testEnv } = await import("@/test/env");
  const env = mod.parseEnv({ ...testEnv, APP_URL: "https://app.test" });
  return { ...mod, getEnv: () => env };
});

const { createOrg, joinOrg, setSummarySettings } = await import("@/lib/db/orgs");
const { sendMeetingSummaries, sendPendingSummaries } = await import("@/lib/summaries/send");
const { POST: postUnsubscribe, GET: getUnsubscribe } = await import("@/app/api/summaries/unsubscribe/route");
const { lookupUnsubscribe } = await import("@/lib/summaries/unsubscribe");

function fakeMailer(ok = true) {
  const sent: MailMessage[] = [];
  return { sent, mailer: { send: async (m: MailMessage) => (sent.push(m), ok) }, now: () => new Date(), sleep: async () => {} };
}

describe.skipIf(!hasLocalSupabase)("meeting summaries (0037)", () => {
  let admin: TestUser;
  let member: TestUser;
  let orgId: string;
  const ids = { anna: "", erik: "", sara: "", nils: "" };
  const db = () => adminClient();

  async function person(name: string, over: Record<string, unknown> = {}): Promise<string> {
    const { data, error } = await db().from("people").insert({ org_id: orgId, name, ...over }).select("id").single();
    if (error) throw new Error(error.message);
    return data.id as string;
  }

  /** A finished meeting: Erik on Närvarande, the admin started it, one decision and Sara's task. */
  async function meeting(over: Record<string, unknown> = {}, items = true): Promise<string> {
    const { data, error } = await db()
      .from("meetings")
      .insert({ org_id: orgId, started_by: admin.id, doc_id: `doc-${randomUUID()}`, notes_tab_id: "t", status: "done", ended_at: new Date().toISOString(), ...over })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const id = data.id as string;
    const rows = [{ meeting_id: id, id: "a1", section: "attendees", kind: "attendee", text: "Erik", position: 0 }];
    if (items) {
      rows.push(
        { meeting_id: id, id: "n1", section: "decision", kind: "decision", text: "Vi kör hackathon", position: 1 },
        { meeting_id: id, id: "n2", section: "action", kind: "task", text: "Boka lokal", position: 2, owner: "Sara" } as (typeof rows)[number],
      );
    }
    const ins = await db().from("note_items").insert(rows);
    if (ins.error) throw new Error(ins.error.message);
    return id;
  }

  const setMode = (mode: string, people: string[] = []) => db().from("orgs").update({ summary_mode: mode }).eq("id", orgId).then(() => people);

  beforeAll(async () => {
    [admin, member] = await Promise.all([createTestUser("sumadmin"), createTestUser("summember")]);
    const r = await createOrg(admin.db, "Sammanfattningsföreningen");
    if (!r.ok) throw new Error("org setup failed");
    orgId = r.id;
    const { data } = await db().from("orgs").select("invite_code").eq("id", orgId).single();
    expect(await joinOrg(member.db, data!.invite_code as string)).toBe(orgId);
    ids.anna = await person("Anna Berg", { member_user_id: admin.id });
    ids.erik = await person("Erik Lund", { email: "erik@example.com" });
    ids.sara = await person("Sara Holm", { email: "sara@example.com" });
    ids.nils = await person("Nils Ek");
  });

  it("defaults to 'missed'; only admins change it, ids must be the förening's", async () => {
    expect((await db().from("orgs").select("summary_mode").eq("id", orgId).single()).data!.summary_mode).toBe("missed");
    expect(await setSummarySettings(member.db as SupabaseClient, orgId, "all", [])).toBe(false);
    expect(await setSummarySettings(admin.db as SupabaseClient, orgId, "selected", [ids.erik])).toBe(true);
    const { data: people } = await db().from("people").select("id, summary_selected").eq("org_id", orgId);
    expect(people!.filter((p) => p.summary_selected).map((p) => p.id)).toEqual([ids.erik]);
    // Another mode keeps the ticks; a foreign id or an unknown mode is refused.
    expect(await setSummarySettings(admin.db as SupabaseClient, orgId, "off", [])).toBe(true);
    expect((await db().from("people").select("summary_selected").eq("id", ids.erik).single()).data!.summary_selected).toBe(true);
    expect(await setSummarySettings(admin.db as SupabaseClient, orgId, "selected", [randomUUID()])).toBe(false);
    expect(await setSummarySettings(admin.db as SupabaseClient, orgId, "bogus" as "off", [])).toBe(false);
    // A member can't write the orgs column directly either.
    const direct = await member.db.from("orgs").update({ summary_mode: "all" }).eq("id", orgId).select("id");
    expect(direct.data ?? []).toHaveLength(0);
    expect(await setSummarySettings(admin.db as SupabaseClient, orgId, "missed", [])).toBe(true);
  });

  it("members can't tick people or unsubscribe someone directly; renaming still works", async () => {
    expect((await member.db.from("people").update({ summary_selected: true }).eq("id", ids.sara)).error).not.toBeNull();
    expect((await member.db.from("people").update({ summary_unsubscribed_at: new Date().toISOString() }).eq("id", ids.sara)).error).not.toBeNull();
    expect((await member.db.from("people").insert({ org_id: orgId, name: "Ny", summary_selected: true })).error).not.toBeNull();
    expect((await member.db.from("people").update({ name: "Sara Holm" }).eq("id", ids.sara)).error).toBeNull();
    // The send ledger is server-only.
    expect((await admin.db.from("meeting_summary_sends").select("person_id")).error).not.toBeNull();
  });

  it("missed: mails only Sara (not there, has an address), once; event holds counts only", async () => {
    const id = await meeting();
    const f = fakeMailer();
    expect(await sendMeetingSummaries(id, f)).toEqual({ state: "sent", sent: 1, failed: 0 });
    expect(f.sent.map((m) => m.to)).toEqual(["sara@example.com"]);
    const mail = f.sent[0];
    expect(mail.subject).toMatch(/^Sammanfattning: Sammanfattningsföreningen \d+ \p{L}+$/u);
    expect(mail.text).toContain("Du missade mötet");
    expect(mail.text).toContain("DINA UPPGIFTER\n- Boka lokal");
    expect(mail.headers!["List-Unsubscribe"]).toMatch(/^<https:\/\/app\.test\/api\/summaries\/unsubscribe\?t=.+>$/);
    expect(mail.headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    // Sara has no account: the Doc link with a note on access.
    expect(mail.text).toContain(`https://docs.google.com/document/d/doc-`);

    // Never twice: the hook and the cron both find nothing to do.
    expect(await sendMeetingSummaries(id, f)).toBeNull();
    await sendPendingSummaries(f, { orgId });
    expect(f.sent).toHaveLength(1);

    const m = (await db().from("meetings").select("summary_state, summary_at").eq("id", id).single()).data!;
    expect(m.summary_state).toBe("sent");
    const ledger = (await db().from("meeting_summary_sends").select("person_id, sent").eq("meeting_id", id)).data;
    expect(ledger).toEqual([{ person_id: ids.sara, sent: true }]);
    const ev = (await db().from("meeting_events").select("detail").eq("meeting_id", id).eq("kind", "summary")).data!;
    expect(ev).toEqual([{ detail: { state: "sent", mode: "missed", recipients: 1, sent: 1, failed: 0 } }]);
    expect(JSON.stringify(ev)).not.toMatch(/sara|Boka/i);
  });

  it("all: the admin's account address, the member page link when the Doc isn't shared, the settings link", async () => {
    await setMode("all");
    const id = await meeting();
    const f = fakeMailer();
    await sendMeetingSummaries(id, f);
    await setMode("missed");
    expect(f.sent.map((m) => m.to).sort()).toEqual([admin.email, "erik@example.com", "sara@example.com"].sort());
    const toAdmin = f.sent.find((m) => m.to === admin.email)!;
    // The admin started the meeting: straight to the Doc, neutral wording, the setting's link.
    expect(toAdmin.text).toMatch(/^Mötet /);
    expect(toAdmin.text).toContain("https://docs.google.com/document/d/");
    expect(toAdmin.text).toContain(`Ändra vilka som får sammanfattningar: https://app.test/orgs/${orgId}#installningar`);
    expect(f.sent.find((m) => m.to === "erik@example.com")!.text).not.toContain("Ändra vilka");
  });

  it("a member without a recorded share gets the förening page's meeting row", async () => {
    const linked = await person("Mia Medlem", { member_user_id: member.id });
    await setMode("all");
    const id = await meeting();
    const f = fakeMailer();
    await sendMeetingSummaries(id, f);
    await setMode("missed");
    await db().from("people").delete().eq("id", linked);
    expect(f.sent.find((m) => m.to === member.email)!.text).toContain(`Öppna protokollet: https://app.test/orgs/${orgId}#mote-${id}`);
  });

  it("test meetings, meetings without notes and 'off' never mail", async () => {
    const f = fakeMailer();
    const test = await meeting({ is_test: true });
    expect((await sendMeetingSummaries(test, f))!.state).toBe("test");
    const empty = await meeting({}, false);
    expect((await sendMeetingSummaries(empty, f))!.state).toBe("no_notes");
    await setMode("off");
    const off = await meeting();
    expect((await sendMeetingSummaries(off, f))!.state).toBe("off");
    await setMode("missed");
    expect(f.sent).toEqual([]);
  });

  it("waits while the Doc is paused; the cron sends once it isn't; old and unfinished meetings are left alone", async () => {
    const f = fakeMailer();
    const paused = await meeting({ doc_paused_at: new Date().toISOString() });
    const old = await meeting({ ended_at: new Date(Date.now() - 72 * 3600_000).toISOString() });
    const live = await meeting({ status: "live", ended_at: null });
    expect(await sendMeetingSummaries(paused, f)).toBeNull();
    expect(await sendMeetingSummaries(live, f)).toBeNull();
    await sendPendingSummaries(f, { orgId });
    expect(f.sent).toHaveLength(0);
    await db().from("meetings").update({ doc_paused_at: null }).eq("id", paused);
    await sendPendingSummaries(f, { orgId });
    expect(f.sent.map((m) => m.to)).toEqual(["sara@example.com"]);
    const states = (await db().from("meetings").select("id, summary_state").in("id", [old, live])).data!;
    expect(states.every((s) => s.summary_state === null)).toBe(true);
  });

  it("a failed send is recorded and not retried", async () => {
    const id = await meeting();
    const f = fakeMailer(false);
    expect(await sendMeetingSummaries(id, f)).toEqual({ state: "sent", sent: 0, failed: 1 });
    await sendPendingSummaries(fakeMailer(), { orgId });
    expect((await db().from("meeting_summary_sends").select("sent").eq("meeting_id", id)).data).toEqual([{ sent: false }]);
  });

  it("one-click unsubscribe (POST) stops Sara's summaries in every mode; GET changes nothing", async () => {
    const id = await meeting();
    const f = fakeMailer();
    await sendMeetingSummaries(id, f);
    const url = f.sent[0].headers!["List-Unsubscribe"].slice(1, -1);
    const get = await getUnsubscribe(new NextRequest(url));
    expect(get.status).toBe(303);
    expect((await db().from("people").select("summary_unsubscribed_at").eq("id", ids.sara).single()).data!.summary_unsubscribed_at).toBeNull();

    const token = new URL(url).searchParams.get("t");
    expect(await lookupUnsubscribe(token)).toEqual({ orgName: "Sammanfattningsföreningen", unsubscribed: false });
    expect(await lookupUnsubscribe("nope")).toBeNull();

    const bad = await postUnsubscribe(new NextRequest(url.replace(/t=.*/, "t=nope"), { method: "POST", body: "List-Unsubscribe=One-Click" }));
    expect(bad.status).toBe(400);
    const res = await postUnsubscribe(new NextRequest(url, { method: "POST", body: "List-Unsubscribe=One-Click" }));
    expect(res.status).toBe(200);
    expect((await postUnsubscribe(new NextRequest(url, { method: "POST" }))).status).toBe(200);
    expect((await db().from("people").select("summary_unsubscribed_at").eq("id", ids.sara).single()).data!.summary_unsubscribed_at).not.toBeNull();
    expect(await lookupUnsubscribe(token)).toEqual({ orgName: "Sammanfattningsföreningen", unsubscribed: true });

    await setSummarySettings(admin.db as SupabaseClient, orgId, "selected", [ids.sara, ids.erik]);
    const next = await meeting();
    const g = fakeMailer();
    await sendMeetingSummaries(next, g);
    await setSummarySettings(admin.db as SupabaseClient, orgId, "missed", []);
    expect(g.sent.map((m) => m.to)).toEqual(["erik@example.com"]);
  });

  it("meeting_events accepts 'summary' and keeps the older kinds", async () => {
    const id = await meeting({}, false);
    for (const kind of ["summary", "checkin", "ended"]) {
      expect((await db().from("meeting_events").insert({ meeting_id: id, kind })).error, kind).toBeNull();
    }
  });
});
