import { beforeAll, describe, expect, it, vi } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import type { CalendarEvent } from "@/lib/calendar/events";
import type { MailMessage, Mailer } from "@/lib/mail";

// 0059 Inför möten against the real schema: the cron's visibility (visible_meeting_ids) is
// exactly what RLS shows each user in a Företag tree (Privat möte included), a customer brief is
// built from the recipient's own visibility only (never a task handoff), the sent-log claims once,
// the category gate and the förening opt-in. Fake calendar and mailer: nothing leaves.

vi.mock("@/lib/supabase/admin", async () => ({ supabaseAdmin: (await import("@/test/local-supabase")).adminClient }));
vi.mock("@/lib/env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/env")>();
  const { testEnv } = await import("@/test/env");
  const env = mod.parseEnv({ ...testEnv, APP_URL: "https://app.test" });
  return { ...mod, getEnv: () => env };
});

const { briefDeps, loadBriefUser, usersByLastCheck } = await import("@/lib/brief/store");
const { briefsForUser } = await import("@/lib/brief/run");
const { briefEventKey } = await import("@/lib/brief/window");
const { saveMyBriefForeningar } = await import("@/lib/brief/prefs");
const { unsubscribeCategory } = await import("@/lib/email/prefs");

type Name = "anna" | "erik" | "jonas" | "maja";
const NAMES: Name[] = ["anna", "erik", "jonas", "maja"];

const must = <T>(what: string, r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

describe.skipIf(!hasLocalSupabase)("Inför möten (0059)", () => {
  const u = {} as Record<Name, TestUser>;
  const m = {} as Record<"dev" | "led" | "priv" | "internal", string>;
  let orgId: string;
  let customerId: string;
  const now = new Date();
  const startsAt = new Date(now.getTime() + 10 * 60_000).toISOString();

  beforeAll(async () => {
    const admin = adminClient();
    const users = await Promise.all(NAMES.map((n) => createTestUser(`brief-${n}`)));
    NAMES.forEach((n, i) => (u[n] = users[i]));
    orgId = must("create", await admin.rpc("create_foretag", { p_user: u.anna.id, p_name: "Briefbolaget", p_root_name: "VD", p_person_name: "Anna" })) as string;
    const root = (must("root", await admin.from("groups").select("id").eq("org_id", orgId).single()) as { id: string }).id;
    const group = async (name: string, parent: string) =>
      (must(name, await admin.from("groups").insert({ org_id: orgId, name, parent_group_id: parent }).select("id").single()) as { id: string }).id;
    const led = await group("Ledning", root);
    const dev = await group("Utveckling", led);
    const com = await group("Kommunikation", led);
    must("members", await admin.from("org_members").insert(["erik", "jonas", "maja"].map((n) => ({ org_id: orgId, user_id: u[n as Name].id, role: "member" }))));
    must(
      "people",
      await admin.from("people").insert([
        { org_id: orgId, name: "Erik", member_user_id: u.erik.id, group_id: led },
        { org_id: orgId, name: "Jonas", member_user_id: u.jonas.id, group_id: dev },
        { org_id: orgId, name: "Maja", member_user_id: u.maja.id, group_id: com },
      ]),
    );
    customerId = must("customer", await admin.rpc("customer_for_domain", { p_org_id: orgId, p_domain: "acme-brief.se", p_name: "Acme" })) as string;
    const meeting = async (startedBy: Name, groupId: string | null, opts: { private?: boolean; attendees?: Name[]; customer?: boolean; daysAgo: number }) => {
      const at = new Date(now.getTime() - opts.daysAgo * 86_400_000).toISOString();
      const row = must(
        "meeting",
        await admin
          .from("meetings")
          .insert({
            org_id: orgId,
            started_by: u[startedBy].id,
            doc_id: "doc",
            notes_tab_id: "t.0",
            status: "done",
            started_at: at,
            group_id: groupId,
            private: opts.private ?? false,
            context_id: opts.customer ? customerId : null,
          })
          .select("id")
          .single(),
      ) as { id: string };
      for (const a of opts.attendees ?? []) must("attendee", await admin.from("meeting_attendees").insert({ meeting_id: row.id, user_id: u[a].id, source: "calendar" }));
      return row.id;
    };
    m.dev = await meeting("jonas", dev, { customer: true, daysAgo: 3 });
    m.led = await meeting("erik", led, { customer: true, daysAgo: 2 });
    m.priv = await meeting("anna", led, { customer: true, private: true, attendees: ["erik"], daysAgo: 1 });
    m.internal = await meeting("anna", null, { daysAgo: 1 });
    const maja = (must("maja", await admin.from("people").select("id").eq("org_id", orgId).eq("name", "Maja").single()) as { id: string }).id;
    must(
      "notes",
      await admin.from("note_items").insert([
        { meeting_id: m.dev, id: "d1", section: "decision", text: "Utveckling: pilot i januari" },
        { meeting_id: m.dev, id: "t1", section: "action", text: "Maja gör offertbilden", owner_person_id: maja },
        { meeting_id: m.led, id: "d1", section: "decision", text: "Ledning: rabatt 10 procent" },
        { meeting_id: m.priv, id: "d1", section: "decision", text: "Privat: lönesamtal" },
        { meeting_id: m.internal, id: "d1", section: "decision", text: "Internt: julbord" },
      ]),
    );
    // Maja's task crosses the boundary: an approved handoff. It must never show up in a brief.
    must(
      "handoff",
      await admin.from("task_handoffs").insert({ org_id: orgId, meeting_id: m.dev, item_id: "t1", owner_person_id: maja, text: "Maja gör offertbilden", status: "approved" }),
    );
  });

  it("visible_meeting_ids (0054) is exactly what RLS shows each user (the tree, Privat möte)", async () => {
    const admin = adminClient();
    const ids = Object.values(m);
    for (const n of NAMES) {
      const rls = ((must("rls", await u[n].db.from("meetings").select("id").in("id", ids)) as { id: string }[]).map((r) => r.id)).sort();
      const fn = ((must("fn", await admin.rpc("visible_meeting_ids", { p_user: u[n].id, p_ids: ids })) as string[]) ?? []).sort();
      expect(fn, n).toEqual(rls);
    }
    // Not callable by a signed-in user (it takes any user id).
    const { error } = await u.jonas.db.rpc("visible_meeting_ids", { p_user: u.anna.id, p_ids: ids });
    expect(error).not.toBeNull();
  });

  async function run(n: Name, eventId: string) {
    const sent: MailMessage[] = [];
    const mailer: Mailer = { send: async (msg) => (sent.push(msg), true) };
    const deps = briefDeps({ db: adminClient(), mailer, pick: async () => null, now: () => now });
    const event: CalendarEvent = {
      id: eventId,
      title: "Avstämning med Acme",
      start: startsAt,
      end: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
      attendees: [{ email: "kim@acme-brief.se", name: "Kim", response: "accepted" }],
    };
    deps.calendar = async () => ({ listEvents: async (cal: string) => (cal === "primary" ? [event] : []) });
    const user = (await loadBriefUser(u[n].id))!;
    const result = await briefsForUser(user, deps);
    return { result, sent };
  }

  it("a customer brief shows only what the recipient may see", async () => {
    const jonas = await run("jonas", `ev-jonas-${Date.now()}`);
    expect(jonas.result.sent).toBe(1);
    const text = jonas.sent[0].text;
    expect(jonas.sent[0].subject).toMatch(/^Inför Avstämning med Acme kl \d\d\.\d\d$/);
    expect(text).toContain("Utveckling: pilot i januari");
    expect(text).toContain("Maja gör offertbilden");
    expect(text).not.toContain("Ledning: rabatt");
    expect(text).not.toContain("Privat: lönesamtal");
    expect(text).not.toContain("Internt: julbord");
    expect(jonas.sent[0].headers?.["List-Unsubscribe"]).toContain("k=meeting_brief");

    const erik = await run("erik", `ev-erik-${Date.now()}`);
    expect(erik.sent[0].text).toContain("Privat: lönesamtal");
    expect(erik.sent[0].text).toContain("Ledning: rabatt");
    expect(erik.sent[0].text).not.toContain("Internt: julbord");
  });

  it("no visible history with the customer (only a handoff): no mail, the row says skipped", async () => {
    const id = `ev-maja-${Date.now()}`;
    const maja = await run("maja", id);
    expect(maja.sent).toEqual([]);
    expect(maja.result.skipped).toBe(1);
    const row = must("row", await adminClient().from("meeting_brief_sends").select("state, scope").eq("user_id", u.maja.id).eq("event_key", briefEventKey(id)).single());
    expect(row).toEqual({ state: "skipped", scope: "customer" });
  });

  it("one brief per meeting per user: a second run and a racing claim send nothing", async () => {
    const id = `ev-twice-${Date.now()}`;
    expect((await run("jonas", id)).sent).toHaveLength(1);
    expect((await run("jonas", id)).sent).toHaveLength(0);
    const deps = briefDeps({ db: adminClient() });
    expect(await deps.claim(u.jonas.id, briefEventKey(id), startsAt, "customer")).toBe(false);
    expect(await deps.claim(u.jonas.id, briefEventKey(`${id}-new`), startsAt, "customer")).toBe(true);
  });

  it("a claim is a lease: held claims are refused, an expired one is taken over (at most 3 attempts)", async () => {
    const admin = adminClient();
    const deps = briefDeps({ db: admin });
    const key = briefEventKey(`ev-lease-${Date.now()}`);
    expect(await deps.claim(u.anna.id, key, startsAt, "org")).toBe(true);
    expect(await deps.claim(u.anna.id, key, startsAt, "org")).toBe(false);
    expect((await deps.sentKeys(u.anna.id, [key])).has(key)).toBe(true);
    const expire = () => admin.from("meeting_brief_sends").update({ lease_until: new Date(Date.now() - 1000).toISOString() }).eq("user_id", u.anna.id).eq("event_key", key);
    must("expire", await expire());
    // The run died: open again, and a later run takes it over.
    expect((await deps.sentKeys(u.anna.id, [key])).has(key)).toBe(false);
    expect(await deps.claim(u.anna.id, key, startsAt, "org")).toBe(true);
    must("expire", await expire());
    expect(await deps.claim(u.anna.id, key, startsAt, "org")).toBe(true);
    must("expire", await expire());
    // Third attempt used: never again.
    expect(await deps.claim(u.anna.id, key, startsAt, "org")).toBe(false);
    expect((await deps.sentKeys(u.anna.id, [key])).has(key)).toBe(true);
    // A finished row is final, lease or not.
    const done = briefEventKey(`ev-done-${Date.now()}`);
    expect(await deps.claim(u.anna.id, done, startsAt, "org")).toBe(true);
    await deps.finish(u.anna.id, done, "sent", false);
    must("expire", await admin.from("meeting_brief_sends").update({ lease_until: new Date(Date.now() - 1000).toISOString() }).eq("user_id", u.anna.id).eq("event_key", done));
    expect(await deps.claim(u.anna.id, done, startsAt, "org")).toBe(false);
  });

  it("users are taken longest-waiting first (never checked, then oldest check)", async () => {
    const admin = adminClient();
    for (const n of ["jonas", "maja"] as Name[]) {
      must("token", await admin.from("google_calendar_tokens").upsert({ user_id: u[n].id, refresh_token_enc: "x", scope: "calendar.readonly" }));
    }
    must("check", await admin.from("meeting_brief_checks").upsert({ user_id: u.jonas.id, checked_at: new Date().toISOString() }));
    must("check", await admin.from("meeting_brief_checks").upsert({ user_id: u.maja.id, checked_at: new Date(Date.now() - 3_600_000).toISOString() }));
    const order = await usersByLastCheck(admin);
    expect(order.indexOf(u.maja.id)).toBeLessThan(order.indexOf(u.jonas.id));
    must("uncheck", await admin.from("meeting_brief_checks").delete().eq("user_id", u.jonas.id));
    const again = await usersByLastCheck(admin);
    expect(again.indexOf(u.jonas.id)).toBeLessThan(again.indexOf(u.maja.id));
    must("cleanup", await admin.from("google_calendar_tokens").delete().in("user_id", [u.jonas.id, u.maja.id]));
  });

  it("the unsubscribe link (meeting_brief off) stops it before the calendar is read", async () => {
    expect(await unsubscribeCategory(u.erik.email, "meeting_brief")).toBe(true);
    const erik = await run("erik", `ev-off-${Date.now()}`);
    expect(erik.result.stopped).toBe("gate");
    expect(erik.sent).toEqual([]);
  });

  it("förening briefs: off by default, the user turns them on for their own account only", async () => {
    expect((await loadBriefUser(u.maja.id))!.briefForeningar).toBe(false);
    expect(await saveMyBriefForeningar(u.maja.db, true)).toBe(true);
    expect((await loadBriefUser(u.maja.id))!.briefForeningar).toBe(true);
    expect((await loadBriefUser(u.jonas.id))!.briefForeningar).toBe(false);
    // Anonymous: refused.
    const { error } = await adminClient().rpc("set_my_brief_foreningar", { p_on: true });
    expect(error).not.toBeNull();
  });
});
