import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";

// 0062: the tree, people first. "Rapporterar till" (set_manager) keeps 0050's model underneath: a
// manager leads an internal team their reports sit in, the team hangs under the group the manager
// sits in. So the visibility rule is unchanged: Simon (top) sees everything; Adam and Eva report to
// Simon; Bo reports to Adam and Cia to Eva. Bo and Cia are cousins and never see each other's team
// meetings; Eva (a level above) sees Adams team's. Only admins draw lines; never a cycle.

const must = <T>(what: string, r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

type Name = "simon" | "adam" | "eva" | "bo" | "cia";
const NAMES: Name[] = ["simon", "adam", "eva", "bo", "cia"];

describe.skipIf(!hasLocalSupabase)("people tree (0062)", () => {
  const u = {} as Record<Name, TestUser>;
  const p = {} as Record<Name, string>;
  let admin: TestUser;
  let orgId: string;

  const person = (id: string) => adminClient().from("people").select("group_id, canvas_x, canvas_y").eq("id", id).single();
  const groupOf = async (n: Name) => (must(n, await person(p[n])) as { group_id: string | null }).group_id;
  const teamOf = async (n: Name) =>
    (must(`team ${n}`, await adminClient().from("groups").select("id, parent_group_id, depth, archived_at").eq("head_person_id", p[n]).is("archived_at", null).maybeSingle()) as {
      id: string;
      parent_group_id: string | null;
      depth: number;
    } | null);
  const manage = (who: TestUser, n: Name, mode: "manager" | "top" | "none", manager: Name | null = null) =>
    who.db.rpc("set_manager", { p_person_id: p[n], p_mode: mode, p_manager_id: manager ? p[manager] : null });

  beforeAll(async () => {
    const db = adminClient();
    admin = await createTestUser("ptree-admin");
    const users = await Promise.all(NAMES.map((n) => createTestUser(`ptree-${n}`)));
    NAMES.forEach((n, i) => (u[n] = users[i]));
    orgId = must("create", await db.rpc("create_foretag", { p_user: admin.id, p_name: "Personbolaget", p_root_name: "Ledning", p_person_name: "Admin" })) as string;
    must("members", await db.from("org_members").insert(NAMES.map((n) => ({ org_id: orgId, user_id: u[n].id, role: "member" }))));
    const rows = must("people", await db.from("people").insert(NAMES.map((n) => ({ org_id: orgId, name: n[0].toUpperCase() + n.slice(1), member_user_id: u[n].id }))).select("id, name")) as {
      id: string;
      name: string;
    }[];
    for (const n of NAMES) p[n] = rows.find((r) => r.name.toLowerCase() === n)!.id;
  });

  it("only an admin draws a line; a member is refused", async () => {
    expect(must("member", await manage(u.adam, "adam", "manager", "simon"))).toBe("forbidden");
    expect(await groupOf("adam")).toBeNull();
  });

  it("builds the tree: the manager leads a team their reports sit in, the team under the manager's group", async () => {
    expect(must("simon top", await manage(admin, "simon", "top"))).toBe("ok");
    for (const [n, m] of [
      ["adam", "simon"],
      ["eva", "simon"],
      ["bo", "adam"],
      ["cia", "eva"],
    ] as [Name, Name][])
      expect(must(n, await manage(admin, n, "manager", m))).toBe("ok");
    const simonTeam = (await teamOf("simon"))!;
    expect(await groupOf("adam")).toBe(simonTeam.id);
    expect(await groupOf("eva")).toBe(simonTeam.id);
    expect(simonTeam.parent_group_id).toBe(await groupOf("simon"));
    expect((await teamOf("adam"))!).toMatchObject({ parent_group_id: simonTeam.id, depth: 2 });
    expect(await groupOf("bo")).toBe((await teamOf("adam"))!.id);
  });

  it("never a cycle: Simon can't report to Bo (two levels below him), nothing changes", async () => {
    const before = await groupOf("simon");
    expect(must("cycle", await manage(admin, "simon", "manager", "bo"))).toBe("cycle");
    expect(await groupOf("simon")).toBe(before);
    expect(await manage(admin, "simon", "manager", "simon").then((x) => x.data)).toBe("invalid");
  });

  it("visibility is the rule as before: own team, every team below your level, no cousins, admins all", async () => {
    const db = adminClient();
    const adamsTeam = (await teamOf("adam"))!.id;
    const m = (must("meeting", await db.from("meetings").insert({ org_id: orgId, started_by: u.bo.id, doc_id: "doc", notes_tab_id: "t.0", status: "done", group_id: adamsTeam }).select("id").single()) as { id: string }).id;
    const sees = async (who: TestUser) => ((await who.db.from("meetings").select("id").eq("id", m)).data ?? []).length === 1;
    expect(await sees(u.bo)).toBe(true); // in the team (and the starter)
    expect(await sees(u.adam)).toBe(true); // its manager
    expect(await sees(u.simon)).toBe(true); // the top
    expect(await sees(u.eva)).toBe(true); // a level above Adams team
    expect(await sees(u.cia)).toBe(false); // a cousin
    expect(await sees(admin)).toBe(true);
  });

  it("one manager: a new line replaces the old; Bo's move leaves Adams team empty, so it is archived", async () => {
    const adamsTeam = (await teamOf("adam"))!.id;
    expect(must("bo to eva", await manage(admin, "bo", "manager", "eva"))).toBe("ok");
    expect(await groupOf("bo")).toBe((await teamOf("eva"))!.id);
    expect(await teamOf("adam")).toBeNull();
    const archived = must("archived", await adminClient().from("groups").select("archived_at").eq("id", adamsTeam).single()) as { archived_at: string | null };
    expect(archived.archived_at).not.toBeNull();
  });

  it("a manager's team moves with them", async () => {
    expect(must("eva to adam", await manage(admin, "eva", "manager", "adam"))).toBe("ok");
    const adamsTeam = (await teamOf("adam"))!;
    expect(await groupOf("eva")).toBe(adamsTeam.id);
    expect((await teamOf("eva"))!).toMatchObject({ parent_group_id: adamsTeam.id, depth: adamsTeam.depth + 1 });
    must("back", await manage(admin, "eva", "manager", "simon"));
  });

  it("out of the tree: refused while someone reports to you; fine once nobody does", async () => {
    expect(must("eva none", await manage(admin, "eva", "none"))).toBe("has_reports");
    expect(must("cia top", await manage(admin, "cia", "top"))).toBe("ok");
    expect(must("bo top", await manage(admin, "bo", "top"))).toBe("ok");
    expect(must("eva none 2", await manage(admin, "eva", "none"))).toBe("ok");
    expect(await groupOf("eva")).toBeNull();
    expect(await teamOf("eva")).toBeNull();
  });

  it("only someone in the tree can be a manager: nobody is placed at the top by becoming one", async () => {
    // Eva is out of the tree (the test before): Bo can't report to her, and she stays out.
    expect(must("to eva", await manage(admin, "bo", "manager", "eva"))).toBe("not_placed");
    expect(await groupOf("eva")).toBeNull();
    expect(await teamOf("eva")).toBeNull();
  });

  it("a member account without a person row: its row and the line in one go; nothing left behind when refused", async () => {
    const db = adminClient();
    const dora = await createTestUser("ptree-dora");
    must("member", await db.from("org_members").insert({ org_id: orgId, user_id: dora.id, role: "member" }));
    const rows = async () => ((await db.from("people").select("id, group_id").eq("org_id", orgId).eq("member_user_id", dora.id)).data ?? []) as { id: string; group_id: string | null }[];
    // Refused (Eva isn't in the tree): no row made.
    expect(must("refused", await admin.db.rpc("set_account_manager", { p_org_id: orgId, p_user_id: dora.id, p_name: "Dora", p_mode: "manager", p_manager_id: p.eva }))).toBe("not_placed");
    expect(await rows()).toEqual([]);
    // A member can't.
    expect(must("member", await u.adam.db.rpc("set_account_manager", { p_org_id: orgId, p_user_id: dora.id, p_name: "Dora", p_mode: "manager", p_manager_id: p.simon }))).toBe("forbidden");
    // The admin: row and line together.
    expect(must("ok", await admin.db.rpc("set_account_manager", { p_org_id: orgId, p_user_id: dora.id, p_name: "Dora", p_mode: "manager", p_manager_id: p.simon }))).toBe("ok");
    expect(await rows()).toEqual([{ id: expect.any(String), group_id: (await teamOf("simon"))!.id }]);
  });

  it("two admins drawing opposite lines at once: one wins, never a loop", async () => {
    const db = adminClient();
    const second = await createTestUser("ptree-admin2");
    must("admin2", await db.from("org_members").insert({ org_id: orgId, user_id: second.id, role: "admin" }));
    // Bo and Cia both at the top (earlier tests), neither leads anyone.
    for (let round = 0; round < 5; round++) {
      must("reset bo", await manage(admin, "bo", "top"));
      must("reset cia", await manage(admin, "cia", "top"));
      const [a, b] = await Promise.all([manage(admin, "bo", "manager", "cia"), manage(second, "cia", "manager", "bo")]);
      const results = [a.data ?? a.error?.code, b.data ?? b.error?.code];
      expect(results.filter((r) => r === "ok")).toHaveLength(1);
      // The people never point at each other.
      const boTeam = await teamOf("bo");
      const ciaTeam = await teamOf("cia");
      const boIn = await groupOf("bo");
      const ciaIn = await groupOf("cia");
      expect(boTeam !== null && ciaIn === boTeam.id && ciaTeam !== null && boIn === ciaTeam.id).toBe(false);
    }
  });

  it("positions: admins save them, members can't, no direct writes, bad input refused whole", async () => {
    expect(must("save", await admin.db.rpc("set_people_canvas", { p_org_id: orgId, p_positions: [{ id: p.simon, x: 120.25, y: -40 }] }))).toBe(1);
    expect(must("simon", await person(p.simon))).toMatchObject({ canvas_x: 120.3, canvas_y: -40 });
    expect(must("member", await u.adam.db.rpc("set_people_canvas", { p_org_id: orgId, p_positions: [{ id: p.simon, x: 1, y: 1 }] }))).toBeNull();
    const bad = await admin.db.rpc("set_people_canvas", { p_org_id: orgId, p_positions: [{ id: p.simon, x: 5, y: 5 }, { id: p.adam, x: "nope", y: 1 }] });
    expect(bad.error?.code).toBe("22023");
    const direct = await admin.db.from("people").update({ canvas_x: 999 }).eq("id", p.simon).select("id");
    expect(direct.error).not.toBeNull();
    expect(must("simon", await person(p.simon))).toMatchObject({ canvas_x: 120.3, canvas_y: -40 });
  });

  it("another org's admin can't draw lines here", async () => {
    const other = await createTestUser("ptree-other");
    must("other org", await adminClient().rpc("create_foretag", { p_user: other.id, p_name: "Andra bolaget", p_root_name: "Topp", p_person_name: "Otto" }));
    expect(must("other", await manage(other, "adam", "top"))).toBe("forbidden");
  });
});
