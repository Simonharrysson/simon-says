import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOrg } from "@/lib/db/orgs";
import { parseOrgRows, parseOverview, type AdminOverview } from "@/lib/admin/stats";
import { adminClient, anonClient, createTestUser, hasLocalSupabase } from "@/test/local-supabase";

// Migration 0066: admin_overview(p_now) and admin_org_stats(), the internal dashboard's aggregates.
// The stack is shared with the other DB files (they run one at a time), so totals are compared as
// deltas around this file's own seed, with one fixed p_now for both reads.

const DAY = 86_400_000;
const ago = (now: number, days: number) => new Date(now - days * DAY).toISOString();
const utcDay = (now: number, days: number) => new Date(now - days * DAY).toISOString().slice(0, 10);
const sum = (o: AdminOverview, k: "meetings" | "users") => o.weeks.reduce((s, w) => s + w[k], 0);

describe.skipIf(!hasLocalSupabase)("admin dashboard aggregates", () => {
  it("counts accounts, active users, orgs per kind, real meetings, minutes, weeks and failures", async () => {
    const admin = adminClient();
    const now = Date.now() + 10 * 60_000;
    const pNow = new Date(now).toISOString();
    const read = async () => {
      const { data, error } = await admin.rpc("admin_overview", { p_now: pNow });
      expect(error).toBeNull();
      return parseOverview(data);
    };
    const before = await read();

    // A signs in (active), B never signs in but started a meeting 20 days ago (active in 30 days
    // only), C does nothing.
    const a = await createTestUser("adm-a");
    const mk = async (label: string) => {
      const { data, error } = await admin.auth.admin.createUser({ email: `${label}-${randomUUID()}@test.local`, email_confirm: true });
      if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
      return data.user.id;
    };
    const b = await mk("adm-b");
    await mk("adm-c");

    const name = `Insiktsklubben ${randomUUID().slice(0, 8)}`;
    const org = await createOrg(a.db, name);
    if (!org.ok) throw new Error("createOrg");
    expect((await a.db.rpc("ensure_my_privat_space")).error).toBeNull();
    expect((await admin.rpc("create_foretag", { p_user: b, p_name: `Insikt AB ${randomUUID().slice(0, 6)}`, p_root_name: "Ledning", p_person_name: "Bo" })).error).toBeNull();

    const meeting = async (startedBy: string, days: number, isTest = false) => {
      const { data, error } = await admin
        .from("meetings")
        .insert({ org_id: org.id, started_by: startedBy, status: "done", started_at: ago(now, days), ended_at: ago(now, days), is_test: isTest })
        .select("id")
        .single();
      if (error) throw new Error(`meeting: ${error.message}`);
      return data.id as string;
    };
    const m1 = await meeting(a.id, 3);
    await meeting(b, 20);
    await meeting(a.id, 100); // before the 12 weeks
    await meeting(a.id, 1, true); // a test meeting: never counted

    // 20 minutes 5 days ago (counted), 999 s 40 days ago (outside the 30 days).
    expect((await admin.from("usage_daily").insert([{ org_id: org.id, day: utcDay(now, 5), seconds: 1200 }, { org_id: org.id, day: utcDay(now, 40), seconds: 999 }])).error).toBeNull();

    // Health: one failed summary, one refused and one delivered summary mail, one failed and one
    // sent brief, one failed invite mail.
    expect((await admin.from("meetings").update({ summary_state: "failed", summary_at: ago(now, 1) }).eq("id", m1)).error).toBeNull();
    const { data: people, error: pe } = await admin.from("people").insert([{ org_id: org.id, name: "Ada" }, { org_id: org.id, name: "Bea" }]).select("id");
    if (pe || !people) throw new Error(`people: ${pe?.message}`);
    expect((await admin.from("meeting_summary_sends").insert([{ meeting_id: m1, person_id: people[0].id, sent: false }, { meeting_id: m1, person_id: people[1].id, sent: true }])).error).toBeNull();
    const key = () => randomBytes(32).toString("hex");
    expect(
      (await admin.from("meeting_brief_sends").insert([
        { user_id: a.id, event_key: key(), event_start: ago(now, 0), scope: "org", state: "failed" },
        { user_id: a.id, event_key: key(), event_start: ago(now, 0), scope: "org", state: "sent" },
      ])).error,
    ).toBeNull();
    const { data: invite, error: ie } = await admin.from("org_invites").insert({ org_id: org.id, email: `inbjuden-${randomUUID().slice(0, 8)}@test.local`, status: "failed" }).select("id").single();
    if (ie || !invite) throw new Error(`invite: ${ie?.message}`);
    expect((await admin.from("org_invite_sends").insert({ invite_id: invite.id, org_id: org.id, outcome: "failed", idem_key: "k1" })).error).toBeNull();

    const after = await read();
    expect(after.users - before.users).toBe(3);
    expect(after.active7 - before.active7).toBe(1);
    expect(after.active30 - before.active30).toBe(2);
    expect({
      forening: after.orgs.forening - before.orgs.forening,
      foretag: after.orgs.foretag - before.orgs.foretag,
      privat: after.orgs.privat - before.orgs.privat,
    }).toEqual({ forening: 1, foretag: 1, privat: 1 });
    expect(after.meetings - before.meetings).toBe(3);
    expect(after.meetings7 - before.meetings7).toBe(1);
    expect(after.minutes30 - before.minutes30).toBe(20);
    expect(after.weeks).toHaveLength(12);
    expect(after.weeks.map((w) => w.week)).toEqual([...after.weeks.map((w) => w.week)].sort());
    expect(new Date(`${after.weeks[0].week}T00:00:00Z`).getUTCDay()).toBe(1); // Mondays
    expect(sum(after, "meetings") - sum(before, "meetings")).toBe(2);
    expect(sum(after, "users") - sum(before, "users")).toBe(3);
    expect({
      summaries: after.health.summaries - before.health.summaries,
      summaryMails: after.health.summaryMails - before.health.summaryMails,
      briefs: after.health.briefs - before.health.briefs,
      invites: after.health.invites - before.health.invites,
    }).toEqual({ summaries: 1, summaryMails: 1, briefs: 1, invites: 1 });

    // The org's own row: counts only, no test meeting, the latest real meeting.
    const { data: rows, error } = await admin.rpc("admin_org_stats");
    expect(error).toBeNull();
    const row = parseOrgRows(rows).find((r) => r.id === org.id);
    expect(row).toMatchObject({ name, kind: "forening", members: 1, meetings: 3 });
    expect(new Date(row!.lastMeetingAt!).getTime()).toBe(new Date(ago(now, 3)).getTime());
    // Nothing but the shown columns comes back (no creator, no invite code, no e-mail).
    expect(Object.keys((rows as Record<string, unknown>[])[0]).sort()).toEqual(["created_at", "id", "kind", "last_meeting_at", "meetings", "members", "name"]);
  });

  it("is callable by the service role only", async () => {
    const u = await createTestUser("adm-deny");
    for (const db of [u.db, anonClient()]) {
      expect((await db.rpc("admin_overview")).error).not.toBeNull();
      expect((await db.rpc("admin_org_stats")).error).not.toBeNull();
    }
  });
});
