import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
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

// The e-mail gate's database answer can be switched off (as when may_email fails): "unknown".
const gate = vi.hoisted(() => ({ down: false }));
vi.mock("@/lib/email/prefs", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/email/prefs")>();
  return { ...mod, checkEmailGate: async (...a: Parameters<typeof mod.checkEmailGate>) => (gate.down ? "unknown" : mod.checkEmailGate(...a)) };
});

const { createOrg, joinOrg, setSummarySettings } = await import("@/lib/db/orgs");
const { sendMeetingSummaries, sendPendingSummaries } = await import("@/lib/summaries/send");
const { POST: postUnsubscribe, GET: getUnsubscribe } = await import("@/app/api/mejl/avsluta/route");

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

  it("members can't tick people or write e-mail addresses directly; renaming still works", async () => {
    expect((await member.db.from("people").update({ summary_selected: true }).eq("id", ids.sara)).error).not.toBeNull();
    expect((await member.db.from("people").insert({ org_id: orgId, name: "Ny", summary_selected: true })).error).not.toBeNull();
    expect((await member.db.from("people").update({ name: "Sara Holm" }).eq("id", ids.sara)).error).toBeNull();
    // E-mail addresses are written only by the admin functions (an e-mail-only recipient is always admin-added).
    expect((await member.db.from("people").update({ email: "fel@example.com" }).eq("id", ids.nils)).error).not.toBeNull();
    expect((await member.db.from("people").insert({ org_id: orgId, name: "Ny", email: "ny@example.com" })).error).not.toBeNull();
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
    expect(mail.headers!["List-Unsubscribe"]).toMatch(/^<https:\/\/app\.test\/api\/mejl\/avsluta\?t=.+&k=meeting_summary>$/);
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
    expect(toAdmin.text).toContain(`Ändra vilka som får sammanfattningar: https://app.test/orgs/${orgId}?flik=installningar#sammanfattning`);
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

  async function voices(meetingId: string, names: (string | null)[]) {
    const session = `el-${randomUUID()}`;
    expect((await db().from("el_sessions").insert({ id: session, meeting_id: meetingId, max_seconds: 3600 })).error).toBeNull();
    const rows = names.map((n, i) => ({
      meeting_id: meetingId,
      el_session_id: session,
      speaker_label: `speaker_${i}`,
      display_name: n ?? `Talare ${i + 1}`,
    }));
    expect((await db().from("speaker_map").insert(rows)).error).toBeNull();
  }

  it("shared mic, unnamed voices: 'missed' sends nothing (uncertain, counted); 'all' sends with neutral wording", async () => {
    const f = fakeMailer();
    const id = await meeting();
    await voices(id, [null, null]);
    expect(await sendMeetingSummaries(id, f)).toEqual({ state: "uncertain", sent: 0, failed: 0 });
    expect(f.sent).toEqual([]);
    const ev = (await db().from("meeting_events").select("detail").eq("meeting_id", id).eq("kind", "summary")).data!;
    expect(ev[0].detail).toMatchObject({ state: "uncertain", unnamedVoices: 2 });

    await setMode("all");
    const all = await meeting();
    await voices(all, [null, null]);
    await sendMeetingSummaries(all, f);
    await setMode("missed");
    expect(f.sent.length).toBeGreaterThan(0);
    expect(f.sent.every((m) => !m.text.includes("missade"))).toBe(true);
  });

  it("stops before its deadline and leaves the meeting 'sending'; the cron sends the rest exactly once", async () => {
    await setMode("all");
    const id = await meeting();
    let clock = Date.now();
    const deadlineAt = new Date(clock + 60_000);
    const first: MailMessage[] = [];
    const slow = {
      mailer: { send: async (m: MailMessage) => (first.push(m), (clock += 3600_000), true) },
      now: () => new Date(clock),
      sleep: async () => {},
    };
    expect(await sendMeetingSummaries(id, slow, { deadlineAt })).toEqual({ state: "sending", sent: 1, failed: 0 });
    expect((await db().from("meetings").select("summary_state").eq("id", id).single()).data!.summary_state).toBe("sending");

    const rest = fakeMailer();
    await sendPendingSummaries(rest, { orgId });
    await sendPendingSummaries(rest, { orgId });
    await setMode("missed");
    const to = [...first, ...rest.sent].map((m) => m.to).sort();
    expect(to).toEqual([admin.email, "erik@example.com", "sara@example.com"].sort());
    expect(new Set(to).size).toBe(to.length);
    expect((await db().from("meetings").select("summary_state").eq("id", id).single()).data!.summary_state).toBe("sent");
    expect((await db().from("meeting_summary_sends").select("person_id").eq("meeting_id", id)).data).toHaveLength(3);
  });

  it("a run that died mid-loop (ledger row, still 'sending'): the cron mails only the others", async () => {
    await setMode("all");
    const id = await meeting();
    await db().from("meetings").update({ summary_state: "sending" }).eq("id", id);
    await db().from("meeting_summary_sends").insert({ meeting_id: id, person_id: ids.erik });
    const f = fakeMailer();
    await sendPendingSummaries(f, { orgId });
    await setMode("missed");
    expect(f.sent.map((m) => m.to).sort()).toEqual([admin.email, "sara@example.com"].sort());
    expect((await db().from("meetings").select("summary_state").eq("id", id).single()).data!.summary_state).toBe("sent");
  });

  it("the gate can't answer: nobody is claimed, the meeting stays 'sending' and the next sweep sends", async () => {
    const id = await meeting();
    gate.down = true;
    const f = fakeMailer();
    try {
      expect(await sendMeetingSummaries(id, f)).toEqual({ state: "sending", sent: 0, failed: 0 });
    } finally {
      gate.down = false;
    }
    expect(f.sent).toEqual([]);
    expect((await db().from("meeting_summary_sends").select("person_id").eq("meeting_id", id)).data).toEqual([]);
    await sendPendingSummaries(f, { orgId });
    expect(f.sent.map((m) => m.to)).toEqual(["sara@example.com"]);
    expect((await db().from("meetings").select("summary_state").eq("id", id).single()).data!.summary_state).toBe("sent");
  });

  it("still 'sending' after the 48 h window: closed as 'partial' with counts, never picked up again", async () => {
    const id = await meeting({ ended_at: new Date(Date.now() - 72 * 3600_000).toISOString(), summary_state: "sending" });
    await db().from("meeting_summary_sends").insert({ meeting_id: id, person_id: ids.erik, sent: true });
    const f = fakeMailer();
    await sendPendingSummaries(f, { orgId });
    await sendPendingSummaries(f, { orgId });
    expect(f.sent).toEqual([]);
    expect((await db().from("meetings").select("summary_state").eq("id", id).single()).data!.summary_state).toBe("partial");
    const ev = (await db().from("meeting_events").select("detail").eq("meeting_id", id).eq("kind", "summary")).data!;
    expect(ev).toEqual([{ detail: { state: "partial", sent: 1, failed: 0 } }]);
  });

  it("a removed member is marked and gets nothing by the old address", async () => {
    const rut = await person("Rut Borttagen", { member_user_id: member.id, email: member.email });
    expect((await admin.db.rpc("remove_member", { p_org_id: orgId, p_user_id: member.id })).error).toBeNull();
    const row = (await db().from("people").select("member_user_id, summary_removed_at").eq("id", rut).single()).data!;
    expect(row.member_user_id).toBeNull();
    expect(row.summary_removed_at).not.toBeNull();
    await setMode("all");
    const id = await meeting();
    const f = fakeMailer();
    await sendMeetingSummaries(id, f);
    await setMode("missed");
    expect(f.sent.map((m) => m.to)).not.toContain(member.email);
    // An admin setting an e-mail again clears the mark.
    expect((await admin.db.rpc("set_person_email", { p_person_id: rut, p_email: "rut@example.com" })).data).toBe("ok");
    expect((await db().from("people").select("summary_removed_at").eq("id", rut).single()).data!.summary_removed_at).toBeNull();
    await db().from("people").delete().eq("id", rut);
  });

  it("through the e-mail gate: the one-click header (0039) stops Sara's summaries in every mode; GET changes nothing", async () => {
    const id = await meeting();
    const f = fakeMailer();
    await sendMeetingSummaries(id, f);
    const mail = f.sent[0];
    expect(mail.to).toBe("sara@example.com");
    const url = mail.headers!["List-Unsubscribe"].slice(1, -1);
    expect(url).toMatch(/^https:\/\/app\.test\/api\/mejl\/avsluta\?t=.+&k=meeting_summary$/);
    expect(mail.text).toMatch(/Avsluta prenumeration: https:\/\/app\.test\/mejl\?t=.+&k=meeting_summary/);

    expect((await getUnsubscribe(new Request(url))).status).toBe(303);
    const again = await meeting();
    const g = fakeMailer();
    await sendMeetingSummaries(again, g);
    expect(g.sent.map((m) => m.to)).toEqual(["sara@example.com"]);

    const res = await postUnsubscribe(new Request(url, { method: "POST", body: "List-Unsubscribe=One-Click" }));
    expect(res.status).toBe(200);

    await setSummarySettings(admin.db as SupabaseClient, orgId, "selected", [ids.sara, ids.erik]);
    const next = await meeting();
    const h = fakeMailer();
    expect(await sendMeetingSummaries(next, h)).toMatchObject({ state: "sent", sent: 1, failed: 0 });
    await setSummarySettings(admin.db as SupabaseClient, orgId, "missed", []);
    expect(h.sent.map((m) => m.to)).toEqual(["erik@example.com"]);
    const ev = (await db().from("meeting_events").select("detail").eq("meeting_id", next).eq("kind", "summary")).data!;
    expect(ev[0].detail).toMatchObject({ sent: 1, optedOut: 1 });
  });

  it("meeting_events accepts 'summary' and keeps the older kinds", async () => {
    const id = await meeting({}, false);
    for (const kind of ["summary", "checkin", "ended"]) {
      expect((await db().from("meeting_events").insert({ meeting_id: id, kind })).error, kind).toBeNull();
    }
  });
});
