import { beforeAll, describe, expect, it } from "vitest";
import { testEnv } from "@/test/env";
import { adminClient, anonClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { createOrg, joinOrg, listMyOrgs } from "@/lib/db/orgs";
import { ensurePrivatSpace } from "@/lib/privat/space";

// 0045: the Privat space. One per account, only its owner can be in it or read anything in it,
// invite codes never lead into it, and deleting the account (or a context, or a meeting) removes
// its data.

const isDenied = (error: { message: string } | null) => Boolean(error && /permission denied|violates row-level security/i.test(error.message));

async function seedPrivatMeeting(orgId: string, userId: string, contextId: string) {
  const admin = adminClient();
  const { data, error } = await admin
    .from("meetings")
    .insert({ org_id: orgId, started_by: userId, status: "done", context_id: contextId, ended_at: new Date().toISOString() })
    .select("id")
    .single();
  if (error) throw new Error(`seed meeting: ${error.message}`);
  const meetingId = data.id as string;
  for (const write of [
    () => admin.from("note_items").insert({ meeting_id: meetingId, id: "n1", section: "decision", text: "Hemligt beslut" }),
    () => admin.from("private_summaries").insert({ meeting_id: meetingId, context_id: contextId, summary: "Hemlig sammanfattning", decisions: ["Hemligt beslut"] }),
    () => admin.from("context_tasks").insert({ context_id: contextId, meeting_id: meetingId, text: "Hemlig uppgift" }),
  ]) {
    const { error: e } = await write();
    if (e) throw new Error(`seed: ${e.message}`);
  }
  return meetingId;
}

describe.skipIf(!hasLocalSupabase)("Privat space (0045)", () => {
  let a: TestUser;
  let b: TestUser;
  let spaceA: string;
  let contextA: string;
  let meetingA: string;

  beforeAll(async () => {
    Object.assign(process.env, testEnv, {
      SUPABASE_URL: process.env.LOCAL_SUPABASE_API_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY,
    });
    [a, b] = await Promise.all([createTestUser("priva"), createTestUser("privb")]);
    spaceA = await ensurePrivatSpace(a.db);
    const { data, error } = await a.db.from("contexts").insert({ org_id: spaceA, name: "TDDE15" }).select("id").single();
    if (error) throw new Error(error.message);
    contextA = data.id;
    meetingA = await seedPrivatMeeting(spaceA, a.id, contextA);
  });

  it("one space per account, created on first use, its owner the only (admin) member", async () => {
    expect(await ensurePrivatSpace(a.db)).toBe(spaceA);
    const [x, y] = await Promise.all([ensurePrivatSpace(b.db), ensurePrivatSpace(b.db)]);
    expect(x).toBe(y);
    const { data } = await adminClient().from("org_members").select("user_id, role").eq("org_id", spaceA);
    expect(data).toEqual([{ user_id: a.id, role: "admin" }]);
    const { data: org } = await adminClient().from("orgs").select("kind").eq("id", spaceA).single();
    expect(org?.kind).toBe("privat");
  });

  it("is not a förening: not in the förening list, doesn't count against the org limit", async () => {
    expect((await listMyOrgs(a.db)).map((o) => o.id)).not.toContain(spaceA);
    const user = await createTestUser("privlimit");
    await ensurePrivatSpace(user.db);
    for (let i = 1; i <= 10; i++) expect((await createOrg(user.db, `Org ${i}`)).ok).toBe(true);
    const { count } = await adminClient().from("org_creations").select("*", { count: "exact", head: true }).eq("user_id", user.id);
    expect(count).toBe(10);
  });

  it("nobody else can read anything in it", async () => {
    for (const [table, column, value] of [
      ["orgs", "id", spaceA],
      ["contexts", "org_id", spaceA],
      ["meetings", "id", meetingA],
      ["note_items", "meeting_id", meetingA],
      ["private_summaries", "meeting_id", meetingA],
      ["context_tasks", "context_id", contextA],
    ] as const) {
      const { data, error } = await b.db.from(table).select("*").eq(column, value);
      expect(error, table).toBeNull();
      expect(data, table).toEqual([]);
      const own = await a.db.from(table).select("*").eq(column, value);
      expect(own.data?.length, `${table} (owner)`).toBeGreaterThan(0);
    }
    const anon = anonClient();
    for (const table of ["contexts", "private_summaries", "context_tasks"]) {
      const { error } = await anon.from(table).select("*").limit(1);
      expect(isDenied(error), `anon ${table}`).toBe(true);
    }
  });

  it("nobody else can write into it", async () => {
    const { error: ctx } = await b.db.from("contexts").insert({ org_id: spaceA, name: "Intrång" });
    expect(isDenied(ctx)).toBe(true);
    const { data: upd } = await b.db.from("context_tasks").update({ done: true }).eq("context_id", contextA).select("id");
    expect(upd ?? []).toEqual([]);
    const { error: sum } = await a.db.from("private_summaries").insert({ meeting_id: meetingA, summary: "x" });
    expect(isDenied(sum)).toBe(true);
  });

  it("nobody can join it: the invite code leads nowhere and a direct insert is refused", async () => {
    const { data: org } = await adminClient().from("orgs").select("invite_code").eq("id", spaceA).single();
    expect(await joinOrg(b.db, org!.invite_code)).toBeNull();
    const { data: name } = await b.db.rpc("invite_org_name", { p_code: org!.invite_code });
    expect(name).toBeNull();
    const { error } = await adminClient().from("org_members").insert({ org_id: spaceA, user_id: b.id, role: "member" });
    expect(error?.message).toMatch(/exactly one member/);
  });

  it("clients can't make a space Privat or create one by hand", async () => {
    const r = await createOrg(b.db, "Låtsasprivat");
    if (!r.ok) throw new Error("org");
    const { error } = await b.db.from("orgs").update({ kind: "privat" }).eq("id", r.id);
    expect(isDenied(error)).toBe(true);
    const { error: ins } = await b.db.from("orgs").insert({ name: "X", kind: "privat", created_by: b.id });
    expect(isDenied(ins)).toBe(true);
  });

  it("the owner ticks a task done; the tick is theirs only", async () => {
    const { data } = await a.db.from("context_tasks").update({ done: true, done_at: new Date().toISOString() }).eq("context_id", contextA).select("done");
    expect(data).toEqual([{ done: true }]);
    const { error } = await a.db.from("context_tasks").update({ text: "Ändrad" }).eq("context_id", contextA);
    expect(isDenied(error)).toBe(true);
  });

  it("deleting a meeting removes its summary and tasks; deleting a context removes its meetings", async () => {
    const admin = adminClient();
    const m2 = await seedPrivatMeeting(spaceA, a.id, contextA);
    const { error } = await a.db.from("meetings").delete().eq("id", m2);
    expect(error).toBeNull();
    for (const t of ["private_summaries", "context_tasks", "note_items"]) {
      const { count } = await admin.from(t).select("*", { count: "exact", head: true }).eq("meeting_id", m2);
      expect(count, t).toBe(0);
    }
    const { data: c2, error: ce } = await a.db.from("contexts").insert({ org_id: spaceA, name: "Att radera" }).select("id").single();
    expect(ce).toBeNull();
    const m3 = await seedPrivatMeeting(spaceA, a.id, c2!.id);
    // Not while one of its meetings runs.
    await admin.from("meetings").update({ status: "live" }).eq("id", m3);
    const { data: kept } = await a.db.from("contexts").delete().eq("id", c2!.id).select("id");
    expect(kept).toEqual([]);
    await admin.from("meetings").update({ status: "done" }).eq("id", m3);
    const { data: gone } = await a.db.from("contexts").delete().eq("id", c2!.id).select("id");
    expect(gone).toEqual([{ id: c2!.id }]);
    const { count } = await admin.from("meetings").select("*", { count: "exact", head: true }).eq("id", m3);
    expect(count).toBe(0);
  });

  it("deleting the account deletes the Privat space and everything in it", async () => {
    const user = await createTestUser("privgone");
    const space = await ensurePrivatSpace(user.db);
    const { data: ctx } = await user.db.from("contexts").insert({ org_id: space, name: "Övrigt" }).select("id").single();
    const meeting = await seedPrivatMeeting(space, user.id, ctx!.id);
    const admin = adminClient();
    const { error } = await admin.auth.admin.deleteUser(user.id);
    expect(error).toBeNull();
    for (const [t, col, v] of [
      ["orgs", "id", space],
      ["contexts", "id", ctx!.id],
      ["meetings", "id", meeting],
      ["private_summaries", "meeting_id", meeting],
    ] as const) {
      const { count } = await admin.from(t).select("*", { count: "exact", head: true }).eq(col, v);
      expect(count, t).toBe(0);
    }
  });

  it("the new e-mail category is in the database's list", async () => {
    const { data } = await adminClient().rpc("email_categories");
    expect(data).toContain("private_summary");
  });
});
