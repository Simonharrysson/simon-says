import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { createOrg } from "@/lib/db/orgs";
import { previousMeeting } from "@/lib/agenda/followup";
import { loadOverviewInput } from "@/lib/dashboard/load";

// 0054: a förening may organise its people in the Företag tree (0050), opt-in, with the same rule
// and the same task delivery. The owner's example (LiU AI Society): Anna (ordförande, admin) and the
// heads Erik (utveckling) and Sara (kommunikation) sit in Styrelsen at the top; Jonas and Lisa in
// Utveckling and Maja in Kommunikation, both under Styrelsen. Olle is a member with no name in the
// list (unplaced once groups are on).

type Name = "anna" | "erik" | "sara" | "jonas" | "lisa" | "maja" | "olle";
const NAMES: Name[] = ["anna", "erik", "sara", "jonas", "lisa", "maja", "olle"];
const LISTED: [Name, string][] = [
  ["anna", "Anna"],
  ["erik", "Erik"],
  ["sara", "Sara"],
  ["jonas", "Jonas"],
  ["lisa", "Lisa"],
  ["maja", "Maja"],
];

const must = <T>(what: string, r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

/** A förening with Anna as admin, everyone a member and every listed name linked; groups off. */
async function forening(u: Record<Name, TestUser>, name: string): Promise<string> {
  const r = await createOrg(u.anna.db, name);
  if (!r.ok) throw new Error("org setup failed");
  const admin = adminClient();
  must("members", await admin.from("org_members").insert(NAMES.filter((n) => n !== "anna").map((n) => ({ org_id: r.id, user_id: u[n].id, role: "member" }))));
  must("people", await admin.from("people").insert(LISTED.map(([n, person]) => ({ org_id: r.id, name: person, member_user_id: u[n].id }))));
  return r.id;
}

async function meeting(orgId: string, startedBy: TestUser, groupId: string | null, opts: { private?: boolean } = {}): Promise<string> {
  return (
    must(
      "meeting",
      await adminClient()
        .from("meetings")
        .insert({ org_id: orgId, started_by: startedBy.id, doc_id: "doc", notes_tab_id: "t.0", status: "done", group_id: groupId, private: opts.private ?? false })
        .select("id")
        .single(),
    ) as { id: string }
  ).id;
}

const personId = async (orgId: string, name: string) =>
  (must(name, await adminClient().from("people").select("id").eq("org_id", orgId).eq("name", name).single()) as { id: string }).id;

describe.skipIf(!hasLocalSupabase)("a förening with groups (0054)", () => {
  const u = {} as Record<Name, TestUser>;

  beforeAll(async () => {
    const users = await Promise.all(NAMES.map((n) => createTestUser(`ftree-${n}`)));
    NAMES.forEach((n, i) => (u[n] = users[i]));
  });

  describe("off (the default): exactly as before", () => {
    let orgId: string;
    let m: string;
    beforeAll(async () => {
      orgId = await forening(u, "Vanlig förening");
      m = await meeting(orgId, u.jonas, null);
      const admin = adminClient();
      must("notes", await admin.from("note_items").insert([{ meeting_id: m, id: "t1", section: "action", text: "Maja gör bilden", owner: "Maja" }]));
      must("session", await admin.from("el_sessions").insert({ id: `el-${m}`, meeting_id: m, max_seconds: 60 }));
      must("speaker", await admin.from("speaker_map").insert({ meeting_id: m, el_session_id: `el-${m}`, speaker_label: "s0", display_name: "Talare 1" }));
      must("event", await admin.from("meeting_events").insert({ meeting_id: m, kind: "tick_ok" }));
    });

    it("the flag is off for a new förening", async () => {
      const org = must("org", await u.anna.db.from("orgs").select("groups_enabled").eq("id", orgId).single()) as { groups_enabled: boolean };
      expect(org.groups_enabled).toBe(false);
    });

    it("every member, the unlisted one too, sees the meeting and every table under it", async () => {
      for (const n of NAMES) {
        const { data } = await u[n].db.from("meetings").select("id").eq("id", m);
        expect(data, n).toEqual([{ id: m }]);
        for (const table of ["note_items", "speaker_map", "meeting_events", "el_sessions"]) {
          const rows = await u[n].db.from(table).select("meeting_id").eq("meeting_id", m);
          expect(rows.data?.length, `${n} ${table}`).toBe(1);
        }
      }
    });

    it("a stray group or Privat flag on a row narrows nothing while groups are off", async () => {
      const g = (must("g", await adminClient().from("groups").insert({ org_id: orgId, name: "Grupp" }).select("id").single()) as { id: string }).id;
      const stray = await meeting(orgId, u.anna, g, { private: true });
      const { data } = await u.olle.db.from("meetings").select("id").eq("id", stray);
      expect(data).toEqual([{ id: stray }]);
    });

    it("a plain member still edits the list (add, rename, link, delete)", async () => {
      const add = await u.olle.db.from("people").insert({ org_id: orgId, name: "Ny person" }).select("id").single();
      expect(add.error).toBeNull();
      const id = (add.data as { id: string }).id;
      const ren = await u.olle.db.from("people").update({ name: "Nyare", member_user_id: u.olle.id }).eq("id", id).select("id");
      expect(ren.data).toEqual([{ id }]);
      const renOther = await u.olle.db.from("people").update({ name: "Erik E" }).eq("org_id", orgId).eq("name", "Erik").select("id");
      expect(renOther.data?.length).toBe(1);
      must("back", await adminClient().from("people").update({ name: "Erik" }).eq("org_id", orgId).eq("name", "Erik E"));
      const del = await u.olle.db.from("people").delete().eq("id", id).select("id");
      expect(del.data).toEqual([{ id }]);
    });

    it("no tree writes and no held tasks while off", async () => {
      expect((await u.anna.db.rpc("set_group", { p_org_id: orgId, p_id: null, p_name: "Utveckling", p_parent: null })).data).toBeNull();
      const maja = await personId(orgId, "Maja");
      expect((await u.anna.db.rpc("set_person_group", { p_person_id: maja, p_group_id: null })).data).toBe(false);
      const n = must("handoffs", await adminClient().rpc("create_task_handoffs", { p_meeting_id: m, p_owners: [{ item_id: "t1", person_id: maja }] }));
      expect(n).toBe(0);
    });
  });

  describe("on: the tree", () => {
    let orgId: string;
    const g = {} as Record<"styrelsen" | "dev" | "com", string>;
    const m = {} as Record<"styrelsen" | "dev" | "com" | "all" | "priv", string>;

    const seen = async (n: Name) => {
      const rows = must("seen", await u[n].db.from("meetings").select("id").eq("org_id", orgId)) as { id: string }[];
      const back = new Map(Object.entries(m).map(([k, id]) => [id, k]));
      return rows.map((r) => back.get(r.id)).filter(Boolean).sort();
    };

    beforeAll(async () => {
      orgId = await forening(u, "LiU AI Society");
      // Only an admin turns it on; the top group is made and every linked person placed in it.
      expect((await u.jonas.db.rpc("set_org_groups", { p_org_id: orgId, p_on: true, p_root_name: "Styrelsen" })).data).toBe(false);
      expect((await u.anna.db.rpc("set_org_groups", { p_org_id: orgId, p_on: true, p_root_name: "Styrelsen" })).data).toBe(true);
      g.styrelsen = (must("root", await u.anna.db.from("groups").select("id").eq("org_id", orgId).single()) as { id: string }).id;
      g.dev = must("dev", await u.anna.db.rpc("set_group", { p_org_id: orgId, p_id: null, p_name: "Utveckling", p_parent: g.styrelsen })) as string;
      g.com = must("com", await u.anna.db.rpc("set_group", { p_org_id: orgId, p_id: null, p_name: "Kommunikation", p_parent: g.styrelsen })) as string;
      for (const [name, group] of [["Jonas", g.dev], ["Lisa", g.dev], ["Maja", g.com]] as const) {
        expect((await u.anna.db.rpc("set_person_group", { p_person_id: await personId(orgId, name), p_group_id: group })).data, name).toBe(true);
      }
      m.styrelsen = await meeting(orgId, u.anna, g.styrelsen);
      m.dev = await meeting(orgId, u.jonas, g.dev);
      m.com = await meeting(orgId, u.maja, g.com);
      m.all = await meeting(orgId, u.anna, null);
      m.priv = await meeting(orgId, u.erik, g.styrelsen, { private: true });
    });

    it("turning on placed every linked person at the top (nobody linked saw less)", async () => {
      const rows = must("people", await adminClient().from("people").select("name, group_id").eq("org_id", orgId)) as { name: string; group_id: string | null }[];
      const at = Object.fromEntries(rows.map((r) => [r.name, r.group_id]));
      expect(at).toEqual({ Anna: g.styrelsen, Erik: g.styrelsen, Sara: g.styrelsen, Jonas: g.dev, Lisa: g.dev, Maja: g.com });
    });

    it("the heads see their own group and every group below; members their own; admins all", async () => {
      expect(await seen("anna")).toEqual(["all", "com", "dev", "priv", "styrelsen"]);
      expect(await seen("erik")).toEqual(["all", "com", "dev", "priv", "styrelsen"]);
      // Sara is a head too, but not at Erik's Privat möte.
      expect(await seen("sara")).toEqual(["all", "com", "dev", "styrelsen"]);
      expect(await seen("jonas")).toEqual(["all", "dev"]);
      expect(await seen("lisa")).toEqual(["all", "dev"]);
    });

    it("no cousins: Kommunikation never sees Utveckling, and the other way round", async () => {
      expect(await seen("maja")).toEqual(["all", "com"]);
      const { data } = await u.lisa.db.from("note_items").select("id").eq("meeting_id", m.com);
      expect(data).toEqual([]);
    });

    it("unplaced (no name in the list): fail closed, only what they start", async () => {
      expect(await seen("olle")).toEqual([]);
      const own = await meeting(orgId, u.olle, null);
      const { data } = await u.olle.db.from("meetings").select("id").eq("id", own);
      expect(data).toEqual([{ id: own }]);
      must("cleanup", await adminClient().from("meetings").delete().eq("id", own));
    });

    it("a task for someone who can't see its meeting waits for approval; then only text, giver, due date", async () => {
      const admin = adminClient();
      const maja = await personId(orgId, "Maja");
      must(
        "notes",
        await admin.from("note_items").insert({ meeting_id: m.dev, id: "t1", section: "action", text: "Maja gör bilden till lanseringen", owner: "Maja", owner_person_id: maja, due: "fredag" }),
      );
      expect(must("held", await admin.rpc("create_task_handoffs", { p_meeting_id: m.dev, p_owners: [{ item_id: "t1", person_id: maja }] }))).toBe(1);
      const mine = async (n: Name) => (must("h", await u[n].db.from("task_handoffs").select("id, status, text, from_name, due").eq("meeting_id", m.dev)) as { id: string; status: string; text: string; from_name: string; due: string }[]);
      // Pending: the starter (and admins) see it; Maja doesn't yet.
      expect(await mine("maja")).toEqual([]);
      const [pending] = await mine("jonas");
      expect(pending.status).toBe("pending");
      // The starter rewrites and approves; Maja then reads only the reviewed task.
      expect((await u.maja.db.rpc("approve_task_handoff", { p_id: pending.id, p_text: "Hack" })).data).toBe(false);
      expect((await u.jonas.db.rpc("approve_task_handoff", { p_id: pending.id, p_text: "Gör en bild till lanseringen" })).data).toBe(true);
      expect(await mine("maja")).toEqual([{ id: pending.id, status: "approved", text: "Gör en bild till lanseringen", from_name: "Jonas", due: "fredag" }]);
      expect((await u.maja.db.from("meetings").select("id").eq("id", m.dev)).data).toEqual([]);
      expect((await u.maja.db.from("note_items").select("id").eq("meeting_id", m.dev)).data).toEqual([]);
      expect((await u.maja.db.rpc("set_task_handoff_done", { p_id: pending.id, p_done: true })).data).toBe(true);
    });

    it("a member can't move up the tree by linking or editing a placed row", async () => {
      const relink = await u.jonas.db.from("people").update({ member_user_id: u.jonas.id }).eq("org_id", orgId).eq("name", "Erik").select("id");
      expect(relink.data ?? []).toEqual([]);
      const unlink = await u.olle.db.from("people").update({ member_user_id: null }).eq("org_id", orgId).eq("name", "Jonas").select("id");
      expect(unlink.data ?? []).toEqual([]);
      const del = await u.olle.db.from("people").delete().eq("org_id", orgId).eq("name", "Maja").select("id");
      expect(del.data ?? []).toEqual([]);
      const place = await u.jonas.db.from("people").update({ group_id: g.styrelsen }).eq("org_id", orgId).eq("name", "Jonas");
      expect(place.error?.message).toMatch(/permission denied/i);
      expect((await u.jonas.db.rpc("set_group", { p_org_id: orgId, p_id: null, p_name: "Hack", p_parent: null })).data).toBeNull();
      expect((await u.jonas.db.rpc("set_person_group", { p_person_id: await personId(orgId, "Jonas"), p_group_id: g.styrelsen })).data).toBe(false);
      // An unplaced row stays a member's to edit, and linking yourself to one gives no place.
      const add = await u.olle.db.from("people").insert({ org_id: orgId, name: "Olle", member_user_id: u.olle.id }).select("id").single();
      expect(add.error).toBeNull();
      expect(await seen("olle")).toEqual([]);
      must("cleanup", await adminClient().from("people").delete().eq("id", (add.data as { id: string }).id));
    });

    it("the last group is kept while groups are on", async () => {
      const other = await forening(u, "En grupp");
      expect((await u.anna.db.rpc("set_org_groups", { p_org_id: other, p_on: true, p_root_name: "Styrelsen" })).data).toBe(true);
      const root = (must("root", await u.anna.db.from("groups").select("id").eq("org_id", other).single()) as { id: string }).id;
      expect((await u.anna.db.rpc("archive_group", { p_id: root })).data).toBe(false);
    });

    it("earlier tasks carry only within the same group, never from a Privat möte; org-wide outputs read only whole-förening meetings", async () => {
      const admin = adminClient();
      const later = new Date(Date.now() + 60_000);
      // Utveckling's next meeting carries from Utveckling's, never from Styrelsen's or Kommunikation's.
      expect((await previousMeeting(orgId, false, later, admin, undefined, { groupId: g.dev }))?.id).toBe(m.dev);
      expect((await previousMeeting(orgId, false, later, admin, undefined, { groupId: null }))?.id).toBe(m.all);
      // A Privat möte is never a source.
      const priv = await meeting(orgId, u.jonas, g.dev, { private: true });
      expect((await previousMeeting(orgId, false, new Date(Date.now() + 120_000), admin, undefined, { groupId: g.dev }))?.id).toBe(m.dev);
      must("cleanup", await admin.from("meetings").delete().eq("id", priv));
      // Förbered möte's topics, goal proposals: an admin's read of every meeting still counts only Hela föreningen's.
      const input = await loadOverviewInput(u.anna.db, orgId);
      expect(input.meetings.map((x) => x.id)).toEqual([m.all]);
    });
  });

  describe("turning on and off", () => {
    it("off opens every meeting to every member again; on again restores the places", async () => {
      const orgId = await forening(u, "Av och på");
      expect((await u.anna.db.rpc("set_org_groups", { p_org_id: orgId, p_on: true, p_root_name: "Styrelsen" })).data).toBe(true);
      const root = (must("root", await u.anna.db.from("groups").select("id").eq("org_id", orgId).single()) as { id: string }).id;
      const dev = must("dev", await u.anna.db.rpc("set_group", { p_org_id: orgId, p_id: null, p_name: "Utveckling", p_parent: root })) as string;
      expect((await u.anna.db.rpc("set_person_group", { p_person_id: await personId(orgId, "Jonas"), p_group_id: dev })).data).toBe(true);
      const top = await meeting(orgId, u.anna, root);
      const canSee = async (n: Name) => ((await u[n].db.from("meetings").select("id").eq("id", top)).data ?? []).length === 1;
      expect(await canSee("jonas")).toBe(false);
      expect(await canSee("olle")).toBe(false);

      expect((await u.jonas.db.rpc("set_org_groups", { p_org_id: orgId, p_on: false, p_root_name: null })).data).toBe(false);
      expect((await u.anna.db.rpc("set_org_groups", { p_org_id: orgId, p_on: false, p_root_name: null })).data).toBe(true);
      expect(await canSee("jonas")).toBe(true);
      expect(await canSee("olle")).toBe(true);

      expect((await u.anna.db.rpc("set_org_groups", { p_org_id: orgId, p_on: true, p_root_name: "Annat namn" })).data).toBe(true);
      expect(await canSee("jonas")).toBe(false);
      const groups = must("groups", await adminClient().from("groups").select("name").eq("org_id", orgId).is("archived_at", null).order("name")) as { name: string }[];
      expect(groups.map((x) => x.name)).toEqual(["Styrelsen", "Utveckling"]);
    });

    it("only a förening: never a Företag or Privat", async () => {
      const ftg = must("ftg", await adminClient().rpc("create_foretag", { p_user: u.anna.id, p_name: "Bolag", p_root_name: "VD", p_person_name: "Anna" })) as string;
      expect((await u.anna.db.rpc("set_org_groups", { p_org_id: ftg, p_on: false, p_root_name: null })).data).toBe(false);
    });
  });
});
