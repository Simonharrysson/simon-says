import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";

// 0063: the old tree RPCs (0050/0054: set_group, set_person_group, place_member, archive_group)
// keep 0062's people-tree rules and take its per-org lock. Simon at the top; Adam reports to
// Simon; Bo to Adam. Cia and Dan are extra people for the concurrent rounds.

const must = <T>(what: string, r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

type Name = "simon" | "adam" | "bo" | "cia" | "dan" | "eve" | "fia";
const NAMES: Name[] = ["simon", "adam", "bo", "cia", "dan", "eve", "fia"];

describe.skipIf(!hasLocalSupabase)("old tree RPCs keep the people-tree rules (0063)", () => {
  const u = {} as Record<Name, TestUser>;
  const p = {} as Record<Name, string>;
  let admin: TestUser;
  let second: TestUser;
  let orgId: string;

  const groupOf = async (n: Name) =>
    (must(n, await adminClient().from("people").select("group_id").eq("id", p[n]).single()) as { group_id: string | null }).group_id;
  const teamOf = async (n: Name) =>
    must(`team ${n}`, await adminClient().from("groups").select("id, parent_group_id").eq("head_person_id", p[n]).is("archived_at", null).maybeSingle()) as {
      id: string;
      parent_group_id: string | null;
    } | null;
  const group = async (id: string) =>
    must("group", await adminClient().from("groups").select("parent_group_id, archived_at").eq("id", id).single()) as { parent_group_id: string | null; archived_at: string | null };
  const manage = (who: TestUser, n: Name, mode: "manager" | "top" | "none", manager: Name | null = null) =>
    who.db.rpc("set_manager", { p_person_id: p[n], p_mode: mode, p_manager_id: manager ? p[manager] : null });
  const move = (who: TestUser, n: Name, groupId: string | null) => who.db.rpc("set_person_group", { p_person_id: p[n], p_group_id: groupId });

  beforeAll(async () => {
    const db = adminClient();
    admin = await createTestUser("trpc-admin");
    second = await createTestUser("trpc-admin2");
    const users = await Promise.all(NAMES.map((n) => createTestUser(`trpc-${n}`)));
    NAMES.forEach((n, i) => (u[n] = users[i]));
    orgId = must("create", await db.rpc("create_foretag", { p_user: admin.id, p_name: "Regelbolaget", p_root_name: "Ledning", p_person_name: "Admin" })) as string;
    must("members", await db.from("org_members").insert([...NAMES.map((n) => ({ org_id: orgId, user_id: u[n].id, role: "member" })), { org_id: orgId, user_id: second.id, role: "admin" }]));
    const rows = must("people", await db.from("people").insert(NAMES.map((n) => ({ org_id: orgId, name: n[0].toUpperCase() + n.slice(1), member_user_id: u[n].id }))).select("id, name")) as {
      id: string;
      name: string;
    }[];
    for (const n of NAMES) p[n] = rows.find((r) => r.name.toLowerCase() === n)!.id;
    expect(must("simon", await manage(admin, "simon", "top"))).toBe("ok");
    expect(must("adam", await manage(admin, "adam", "manager", "simon"))).toBe("ok");
    expect(must("bo", await manage(admin, "bo", "manager", "adam"))).toBe("ok");
  });

  it("set_person_group: a head with reports is never unplaced", async () => {
    const before = await groupOf("adam");
    expect(must("unplace", await move(admin, "adam", null))).toBe(false);
    expect(await groupOf("adam")).toBe(before);
    expect(await teamOf("adam")).not.toBeNull();
  });

  it("set_person_group: never into your own team or below it", async () => {
    const before = await groupOf("simon");
    expect(must("own team", await move(admin, "simon", (await teamOf("simon"))!.id))).toBe(false);
    expect(must("below", await move(admin, "simon", (await teamOf("adam"))!.id))).toBe(false);
    expect(await groupOf("simon")).toBe(before);
  });

  it("set_person_group: the head's team moves with them", async () => {
    const top = (await groupOf("simon"))!;
    expect(must("adam to top", await move(admin, "adam", top))).toBe(true);
    expect((await teamOf("adam"))!.parent_group_id).toBe(top);
    // Simons team is empty now: archived (0062's tidy).
    expect(await teamOf("simon")).toBeNull();
    expect(must("back", await manage(admin, "adam", "manager", "simon"))).toBe("ok");
    expect((await teamOf("adam"))!.parent_group_id).toBe((await teamOf("simon"))!.id);
  });

  it("place_member: same rules for an existing row", async () => {
    expect((await admin.db.rpc("place_member", { p_org_id: orgId, p_user_id: u.adam.id, p_group_id: null, p_name: "Adam" })).data).toBeNull();
    expect((await admin.db.rpc("place_member", { p_org_id: orgId, p_user_id: u.simon.id, p_group_id: (await teamOf("adam"))!.id, p_name: "Simon" })).data).toBeNull();
    expect(await groupOf("adam")).toBe((await teamOf("simon"))!.id);
    // A legal move still answers with the row.
    expect(must("bo", await admin.db.rpc("place_member", { p_org_id: orgId, p_user_id: u.bo.id, p_group_id: (await teamOf("simon"))!.id, p_name: "Bo" }))).toBe(p.bo);
    expect(must("bo back", await manage(admin, "bo", "manager", "adam"))).toBe("ok");
  });

  it("set_group: a team stays under its head (renaming is fine); no group under itself", async () => {
    const adamsTeam = (await teamOf("adam"))!;
    const top = (await groupOf("simon"))!;
    expect((await admin.db.rpc("set_group", { p_org_id: orgId, p_id: adamsTeam.id, p_name: "X", p_parent: top })).data).toBeNull();
    expect((await group(adamsTeam.id)).parent_group_id).toBe(adamsTeam.parent_group_id);
    expect(must("rename", await admin.db.rpc("set_group", { p_org_id: orgId, p_id: adamsTeam.id, p_name: "X", p_parent: adamsTeam.parent_group_id }))).toBe(adamsTeam.id);
    // Headless groups (0050/0054) move freely, but never under themselves: refused, not an error.
    const a = must("a", await admin.db.rpc("set_group", { p_org_id: orgId, p_id: null, p_name: "A", p_parent: top })) as string;
    const b = must("b", await admin.db.rpc("set_group", { p_org_id: orgId, p_id: null, p_name: "B", p_parent: a })) as string;
    expect(must("a under b", await admin.db.rpc("set_group", { p_org_id: orgId, p_id: a, p_name: "A", p_parent: b }))).toBeNull();
    expect(must("b to top", await admin.db.rpc("set_group", { p_org_id: orgId, p_id: b, p_name: "B", p_parent: top }))).toBe(b);
  });

  it("archive_group: never the group a head with an active team sits in", async () => {
    expect(must("simons team", await admin.db.rpc("archive_group", { p_id: (await teamOf("simon"))!.id }))).toBe(false);
    expect(await groupOf("adam")).toBe((await teamOf("simon"))!.id);
  });

  it("concurrent: set_manager and set_person_group in opposite directions never make a loop", async () => {
    // Cia leads Eve, Dan leads Fia; both at the top. One admin puts Cia under Dan (set_manager),
    // the other Dan into Cias team (the old RPC) at the same moment.
    for (let round = 0; round < 5; round++) {
      for (const n of ["cia", "dan"] as Name[]) must(`reset ${n}`, await manage(admin, n, "top"));
      must("eve", await manage(admin, "eve", "manager", "cia"));
      must("fia", await manage(admin, "fia", "manager", "dan"));
      const ciaTeam = (await teamOf("cia"))!.id;
      const [a, b] = await Promise.all([manage(admin, "cia", "manager", "dan"), move(second, "dan", ciaTeam)]);
      const ok = [a.data === "ok", b.data === true].filter(Boolean);
      expect(ok, `round ${round}: ${JSON.stringify([a.data ?? a.error?.message, b.data ?? b.error?.message])}`).toHaveLength(1);
      const [ciaIn, danIn, ct, dt] = [await groupOf("cia"), await groupOf("dan"), await teamOf("cia"), await teamOf("dan")];
      expect(ct !== null && dt !== null && ciaIn === dt.id && danIn === ct.id).toBe(false);
      // Whoever moved, their team followed them.
      if (ct) expect(ct.parent_group_id).toBe(ciaIn);
      if (dt) expect(dt.parent_group_id).toBe(danIn);
    }
  });

  it("concurrent: set_group A-under-B and B-under-A, one wins, never a loop", async () => {
    const top = (await groupOf("simon"))!;
    for (let round = 0; round < 5; round++) {
      const a = must("a", await admin.db.rpc("set_group", { p_org_id: orgId, p_id: null, p_name: `A${round}`, p_parent: top })) as string;
      const b = must("b", await admin.db.rpc("set_group", { p_org_id: orgId, p_id: null, p_name: `B${round}`, p_parent: top })) as string;
      const [x, y] = await Promise.all([
        admin.db.rpc("set_group", { p_org_id: orgId, p_id: a, p_name: `A${round}`, p_parent: b }),
        second.db.rpc("set_group", { p_org_id: orgId, p_id: b, p_name: `B${round}`, p_parent: a }),
      ]);
      expect([x.data, y.data].filter((d) => d !== null), JSON.stringify([x.error?.message, y.error?.message])).toHaveLength(1);
      const [ga, gb] = [await group(a), await group(b)];
      expect(ga.parent_group_id === b && gb.parent_group_id === a).toBe(false);
    }
  });

  it("concurrent: archive_group against a move into that group leaves nobody in an archived group", async () => {
    const top = (await groupOf("simon"))!;
    for (let round = 0; round < 5; round++) {
      must("fia top", await manage(admin, "fia", "top"));
      const g = must("g", await admin.db.rpc("set_group", { p_org_id: orgId, p_id: null, p_name: `G${round}`, p_parent: top })) as string;
      const [x, y] = await Promise.all([admin.db.rpc("archive_group", { p_id: g }), move(second, "fia", g)]);
      expect(x.error, x.error?.message).toBeNull();
      expect(y.error, y.error?.message).toBeNull();
      const fiaIn = await groupOf("fia");
      if (fiaIn) expect((await group(fiaIn)).archived_at).toBeNull();
    }
  });
});
