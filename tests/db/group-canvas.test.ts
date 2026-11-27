import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";

// 0055: card positions and a group's head on the canvas. Everyone in the org reads them (like the
// rest of groups); only an admin of that org writes them, only through the admin functions; a
// direct write is never allowed. Neither ever changes who sees what.

const must = <T>(what: string, r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

describe.skipIf(!hasLocalSupabase)("group canvas (0055)", () => {
  let anna: TestUser; // admin of Testbolag
  let jonas: TestUser; // member of Testbolag
  let other: TestUser; // admin of another company
  let orgId: string;
  let otherOrg: string;
  const g = {} as Record<"vd" | "dev", string>;
  let jonasPerson: string;

  const canvas = (id: string) => adminClient().from("groups").select("canvas_x, canvas_y, head_person_id").eq("id", id).single();

  beforeAll(async () => {
    const admin = adminClient();
    [anna, jonas, other] = await Promise.all([createTestUser("gcv-anna"), createTestUser("gcv-jonas"), createTestUser("gcv-other")]);
    orgId = must("create", await admin.rpc("create_foretag", { p_user: anna.id, p_name: "Canvasbolaget", p_root_name: "VD", p_person_name: "Anna" })) as string;
    otherOrg = must("create other", await admin.rpc("create_foretag", { p_user: other.id, p_name: "Andra bolaget", p_root_name: "VD", p_person_name: "Otto" })) as string;
    g.vd = (must("root", await admin.from("groups").select("id").eq("org_id", orgId).single()) as { id: string }).id;
    g.dev = (must("dev", await admin.from("groups").insert({ org_id: orgId, name: "Utveckling", parent_group_id: g.vd }).select("id").single()) as { id: string }).id;
    must("member", await admin.from("org_members").insert({ org_id: orgId, user_id: jonas.id, role: "member" }));
    jonasPerson = (
      must("person", await admin.from("people").insert({ org_id: orgId, name: "Jonas", member_user_id: jonas.id, group_id: g.dev }).select("id").single()) as { id: string }
    ).id;
  });

  it("new columns start empty and members read them", async () => {
    const rows = must("read", await jonas.db.from("groups").select("id, canvas_x, canvas_y, head_person_id").eq("org_id", orgId)) as {
      canvas_x: number | null;
      head_person_id: string | null;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.canvas_x === null && r.head_person_id === null)).toBe(true);
  });

  it("an admin saves positions for several cards at once", async () => {
    const n = must("save", await anna.db.rpc("set_group_canvas", { p_org_id: orgId, p_positions: [{ id: g.vd, x: 120.25, y: -40 }, { id: g.dev, x: 80, y: 260 }] }));
    expect(n).toBe(2);
    expect(must("vd", await canvas(g.vd))).toMatchObject({ canvas_x: 120.3, canvas_y: -40 });
    expect(must("dev", await canvas(g.dev))).toMatchObject({ canvas_x: 80, canvas_y: 260 });
  });

  it("a member cannot save positions (refused, nothing changes)", async () => {
    expect(must("member save", await jonas.db.rpc("set_group_canvas", { p_org_id: orgId, p_positions: [{ id: g.vd, x: 1, y: 1 }] }))).toBeNull();
    expect(must("vd", await canvas(g.vd))).toMatchObject({ canvas_x: 120.3, canvas_y: -40 });
  });

  it("another company's admin cannot move these cards, even naming their own org", async () => {
    expect(must("other org", await other.db.rpc("set_group_canvas", { p_org_id: orgId, p_positions: [{ id: g.vd, x: 1, y: 1 }] }))).toBeNull();
    // Their own org id with our group: no row of theirs, nothing changes.
    expect(must("other own", await other.db.rpc("set_group_canvas", { p_org_id: otherOrg, p_positions: [{ id: g.vd, x: 1, y: 1 }] }))).toBe(0);
    expect(must("vd", await canvas(g.vd))).toMatchObject({ canvas_x: 120.3, canvas_y: -40 });
    // And they don't see our groups at all.
    expect(must("other read", await other.db.from("groups").select("id").eq("org_id", orgId))).toEqual([]);
  });

  it("bad positions are refused whole", async () => {
    const bad = await anna.db.rpc("set_group_canvas", { p_org_id: orgId, p_positions: [{ id: g.vd, x: 5, y: 5 }, { id: g.dev, x: "nope", y: 1 }] });
    expect(bad.error?.code).toBe("22023");
    const far = await anna.db.rpc("set_group_canvas", { p_org_id: orgId, p_positions: [{ id: g.vd, x: 5e7, y: 0 }] });
    expect(far.error?.code).toBe("22023");
    expect(must("vd", await canvas(g.vd))).toMatchObject({ canvas_x: 120.3, canvas_y: -40 });
  });

  it("no direct writes: an admin's update of groups touches nothing", async () => {
    const { data, error } = await anna.db.from("groups").update({ canvas_x: 999 }).eq("id", g.vd).select("id");
    expect(error !== null || (data ?? []).length === 0).toBe(true);
    expect(must("vd", await canvas(g.vd))).toMatchObject({ canvas_x: 120.3 });
  });

  it("a head: admins set and clear it; members cannot; a person from another org is refused", async () => {
    expect(must("member head", await jonas.db.rpc("set_group_head", { p_group_id: g.dev, p_person_id: jonasPerson }))).toBe(false);
    expect(must("set", await anna.db.rpc("set_group_head", { p_group_id: g.dev, p_person_id: jonasPerson }))).toBe(true);
    expect(must("dev", await canvas(g.dev))).toMatchObject({ head_person_id: jonasPerson });
    const otto = (must("otto", await adminClient().from("people").select("id").eq("org_id", otherOrg).single()) as { id: string }).id;
    expect(must("foreign", await anna.db.rpc("set_group_head", { p_group_id: g.dev, p_person_id: otto }))).toBe(false);
    expect(must("other admin", await other.db.rpc("set_group_head", { p_group_id: g.dev, p_person_id: null }))).toBe(false);
    expect(must("clear", await anna.db.rpc("set_group_head", { p_group_id: g.dev, p_person_id: null }))).toBe(true);
    expect(must("dev", await canvas(g.dev))).toMatchObject({ head_person_id: null });
  });

  it("a förening without groups has no canvas to save", async () => {
    const f = (must("forening", await adminClient().from("orgs").insert({ name: "Föreningen", created_by: anna.id }).select("id").single()) as { id: string }).id;
    // The creator is its admin (0002's trigger).
    expect(must("forening save", await anna.db.rpc("set_group_canvas", { p_org_id: f, p_positions: [] }))).toBeNull();
  });
});
