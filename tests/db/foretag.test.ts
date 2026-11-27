import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";

// 0050: Företag visibility follows the company tree, in the database. The tree (spec's worked
// examples): Anna (VD, admin) at the root; Erik and Sara (heads) in Ledning; Jonas and Lisa in
// Utveckling, Maja in Kommunikation, Kim (kassör) in Ekonomi, all under Ledning; Olle unplaced.

type Name = "anna" | "erik" | "sara" | "jonas" | "lisa" | "maja" | "kim" | "olle";
const NAMES: Name[] = ["anna", "erik", "sara", "jonas", "lisa", "maja", "kim", "olle"];

const must = <T>(what: string, r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

describe.skipIf(!hasLocalSupabase)("Företag visibility (0050)", () => {
  const u = {} as Record<Name, TestUser>;
  const g = {} as Record<"vd" | "led" | "dev" | "com" | "eko", string>;
  const m = {} as Record<"dev" | "led" | "all" | "priv" | "kim", string>;
  let orgId: string;
  let forening: { id: string; meeting: string; member: TestUser };

  async function meeting(startedBy: Name, groupId: string | null, opts: { private?: boolean; attendees?: Name[] } = {}) {
    const admin = adminClient();
    const row = must(
      "meeting",
      await admin
        .from("meetings")
        .insert({ org_id: orgId, started_by: u[startedBy].id, doc_id: "doc", notes_tab_id: "t.0", status: "done", group_id: groupId, private: opts.private ?? false })
        .select("id")
        .single(),
    ) as { id: string };
    for (const a of opts.attendees ?? []) must("attendee", await admin.from("meeting_attendees").insert({ meeting_id: row.id, user_id: u[a].id, source: "calendar" }));
    return row.id;
  }

  beforeAll(async () => {
    const admin = adminClient();
    const users = await Promise.all(NAMES.map((n) => createTestUser(`ftg-${n}`)));
    NAMES.forEach((n, i) => (u[n] = users[i]));
    orgId = must("create", await admin.rpc("create_foretag", { p_user: u.anna.id, p_name: "Testbolag", p_root_name: "VD", p_person_name: "Anna" })) as string;
    g.vd = (must("root", await admin.from("groups").select("id").eq("org_id", orgId).single()) as { id: string }).id;
    const group = async (name: string, parent: string) =>
      (must(name, await admin.from("groups").insert({ org_id: orgId, name, parent_group_id: parent }).select("id").single()) as { id: string }).id;
    g.led = await group("Ledning", g.vd);
    [g.dev, g.com, g.eko] = await Promise.all([group("Utveckling", g.led), group("Kommunikation", g.led), group("Ekonomi", g.led)]);
    must("members", await admin.from("org_members").insert(NAMES.filter((n) => n !== "anna").map((n) => ({ org_id: orgId, user_id: u[n].id, role: "member" }))));
    const place: [Name, string, string][] = [
      ["erik", "Erik", g.led],
      ["sara", "Sara", g.led],
      ["jonas", "Jonas", g.dev],
      ["lisa", "Lisa", g.dev],
      ["maja", "Maja", g.com],
      ["kim", "Kim", g.eko],
    ];
    must("people", await admin.from("people").insert(place.map(([n, name, group]) => ({ org_id: orgId, name, member_user_id: u[n].id, group_id: group }))));
    const maja = (must("maja", await admin.from("people").select("id").eq("org_id", orgId).eq("name", "Maja").single()) as { id: string }).id;

    m.dev = await meeting("jonas", g.dev);
    m.led = await meeting("erik", g.led);
    m.all = await meeting("anna", null);
    m.priv = await meeting("anna", g.led, { private: true, attendees: ["erik"] });
    m.kim = await meeting("kim", g.dev);
    must(
      "notes",
      await admin.from("note_items").insert([
        { meeting_id: m.dev, id: "t1", section: "action", text: "Maja gör bilden", owner_person_id: maja },
        { meeting_id: m.dev, id: "t2", section: "decision", text: "Vi kör" },
      ]),
    );
    must("session", await admin.from("el_sessions").insert({ id: `el-${m.dev}`, meeting_id: m.dev, max_seconds: 60 }));
    must("speaker", await admin.from("speaker_map").insert({ meeting_id: m.dev, el_session_id: `el-${m.dev}`, speaker_label: "s0", display_name: "Talare 1" }));
    must("event", await admin.from("meeting_events").insert({ meeting_id: m.dev, kind: "tick_ok" }));

    // A förening: a stray group_id / private flag never narrows what its members see.
    const member = await createTestUser("ftg-fmember");
    const fOrg = (must("forening", await admin.from("orgs").insert({ name: "Föreningen", created_by: u.olle.id }).select("id").single()) as { id: string }).id;
    must("fmember", await admin.from("org_members").insert({ org_id: fOrg, user_id: member.id, role: "member" }));
    const stray = (must("stray", await admin.from("groups").insert({ org_id: fOrg, name: "Grupp" }).select("id").single()) as { id: string }).id;
    const fm = (must(
      "fmeeting",
      await admin.from("meetings").insert({ org_id: fOrg, started_by: u.olle.id, doc_id: "doc", notes_tab_id: "t.0", status: "done", group_id: stray, private: true }).select("id").single(),
    ) as { id: string }).id;
    forening = { id: fOrg, meeting: fm, member };
  });

  const seen = async (n: Name) => {
    const rows = must("seen", await u[n].db.from("meetings").select("id").eq("org_id", orgId)) as { id: string }[];
    const back = new Map(Object.entries(m).map(([k, id]) => [id, k]));
    return rows.map((r) => back.get(r.id)).sort();
  };

  it("follows the tree: own group, every deeper group, admins all, Hela företaget for everyone", async () => {
    expect(await seen("anna")).toEqual(["all", "dev", "kim", "led", "priv"]);
    expect(await seen("erik")).toEqual(["all", "dev", "kim", "led", "priv"]);
    expect(await seen("sara")).toEqual(["all", "dev", "kim", "led"]);
    expect(await seen("jonas")).toEqual(["all", "dev", "kim"]);
    expect(await seen("lisa")).toEqual(["all", "dev", "kim"]);
    // A cousin (Kommunikation) never sees Utveckling's meetings.
    expect(await seen("maja")).toEqual(["all"]);
    // The cashier: never Ledning's salary review; their own start always.
    expect(await seen("kim")).toEqual(["all", "kim"]);
    // Unplaced: fail closed, not even Hela företaget (only what they start or attend).
    expect(await seen("olle")).toEqual([]);
  });

  it("a Privat möte: only attendees, the starter and admins (not a head who wasn't there)", async () => {
    const { data } = await u.sara.db.from("meetings").select("id").eq("id", m.priv);
    expect(data).toEqual([]);
    const { data: erik } = await u.erik.db.from("meetings").select("id").eq("id", m.priv);
    expect(erik).toEqual([{ id: m.priv }]);
  });

  it("everything under a meeting follows, the owner's own task row included", async () => {
    const maja = await u.maja.db.from("note_items").select("id").eq("meeting_id", m.dev);
    expect(maja.data).toEqual([]);
    for (const table of ["speaker_map", "meeting_events", "el_sessions"]) {
      const { data } = await u.maja.db.from(table).select("meeting_id").eq("meeting_id", m.dev);
      expect(data, table).toEqual([]);
      const { data: jonas } = await u.jonas.db.from(table).select("meeting_id").eq("meeting_id", m.dev);
      expect(jonas?.length, table).toBe(1);
    }
    const jonas = await u.jonas.db.from("note_items").select("id").eq("meeting_id", m.dev).order("id");
    expect(jonas.data).toEqual([{ id: "t1" }, { id: "t2" }]);
  });

  it("members can't move themselves up the tree", async () => {
    const relink = await u.jonas.db.from("people").update({ member_user_id: u.jonas.id }).eq("org_id", orgId).eq("name", "Erik").select("id");
    expect(relink.data ?? []).toEqual([]);
    const place = await u.jonas.db.from("people").update({ group_id: g.vd }).eq("org_id", orgId).eq("name", "Jonas");
    expect(place.error?.message).toMatch(/permission denied/i);
    const add = await u.jonas.db.from("people").insert({ org_id: orgId, name: "Ny" });
    expect(add.error?.message).toMatch(/row-level security/i);
    expect((await u.jonas.db.rpc("set_group", { p_org_id: orgId, p_id: null, p_name: "Hack", p_parent: null })).data).toBeNull();
    const personId = (must("p", await adminClient().from("people").select("id").eq("org_id", orgId).eq("name", "Jonas").single()) as { id: string }).id;
    expect((await u.jonas.db.rpc("set_person_group", { p_person_id: personId, p_group_id: g.vd })).data).toBe(false);
    const attend = await u.maja.db.from("meeting_attendees").insert({ meeting_id: m.dev, user_id: u.maja.id, source: "listed" });
    expect(attend.error).not.toBeNull();
  });

  it("the tree: no cycles, a move recomputes depth (and what people see)", async () => {
    const admin = adminClient();
    const cycle = await admin.from("groups").update({ parent_group_id: g.dev }).eq("id", g.led);
    expect(cycle.error?.message).toMatch(/under itself/);
    const team = (must("team", await admin.from("groups").insert({ org_id: orgId, name: "Team", parent_group_id: g.dev }).select("id, depth").single()) as { id: string; depth: number });
    expect(team.depth).toBe(3);
    expect((await u.anna.db.rpc("set_group", { p_org_id: orgId, p_id: g.dev, p_name: "Utveckling", p_parent: g.vd })).data).toBe(g.dev);
    const depths = must("depths", await admin.from("groups").select("id, depth").in("id", [g.dev, team.id])) as { id: string; depth: number }[];
    expect(Object.fromEntries(depths.map((d) => [d.id, d.depth]))).toEqual({ [g.dev]: 1, [team.id]: 2 });
    // Utveckling now sits beside Ledning: Sara (depth 1, another group) no longer sees it.
    expect(await seen("sara")).toEqual(["all", "led"]);
    expect((await u.anna.db.rpc("set_group", { p_org_id: orgId, p_id: g.dev, p_name: "Utveckling", p_parent: g.led })).data).toBe(g.dev);
    expect(await seen("sara")).toEqual(["all", "dev", "kim", "led"]);
  });

  it("the server's viewer lists match RLS", async () => {
    const admin = adminClient();
    const viewers = must("viewers", await admin.rpc("foretag_viewer_ids", { p_meeting_id: m.dev })) as string[];
    const names = (ids: string[]) => NAMES.filter((n) => ids.includes(u[n].id)).sort();
    expect(names(viewers)).toEqual(["anna", "erik", "jonas", "lisa", "sara"]);
    const audience = must(
      "audience",
      await admin.rpc("foretag_audience_ids", { p_org: orgId, p_group: g.led, p_private: true, p_started_by: u.anna.id, p_attendees: [u.erik.id] }),
    ) as string[];
    expect(names(audience)).toEqual(["anna", "erik"]);
    expect(await u.jonas.db.rpc("foretag_viewer_ids", { p_meeting_id: m.dev }).then((r) => r.error)).not.toBeNull();
  });

  it("customers: one per domain, created by the server, never deleted by a client", async () => {
    const admin = adminClient();
    const id = must("customer", await admin.rpc("customer_for_domain", { p_org_id: orgId, p_domain: "acme.se", p_name: "Acme" })) as string;
    expect(must("again", await admin.rpc("customer_for_domain", { p_org_id: orgId, p_domain: "acme.se", p_name: "Acme" }))).toBe(id);
    const del = await u.anna.db.from("contexts").delete().eq("id", id).select("id");
    expect(del.data ?? []).toEqual([]);
    expect(await u.jonas.db.rpc("customer_for_domain", { p_org_id: orgId, p_domain: "x.se", p_name: "X" }).then((r) => r.error)).not.toBeNull();
  });

  it("customers: read by admins and by viewers of a meeting with them; renamed by admins only", async () => {
    const admin = adminClient();
    const id = must("customer", await admin.rpc("customer_for_domain", { p_org_id: orgId, p_domain: "kund.se", p_name: "Kund" })) as string;
    const reads = async (n: Name) => ((await u[n].db.from("contexts").select("id").eq("id", id)).data ?? []).length === 1;
    // No meeting with it yet: only the admin.
    expect(await reads("anna")).toBe(true);
    expect(await reads("jonas")).toBe(false);
    // A meeting for Utveckling with the customer: Utveckling and the heads read it, the cousin never.
    must("link", await admin.from("meetings").update({ context_id: id }).eq("id", m.dev));
    expect(await reads("jonas")).toBe(true);
    expect(await reads("erik")).toBe(true);
    expect(await reads("maja")).toBe(false);
    // A member who reads it still can't rename it; an admin can.
    const member = await u.jonas.db.from("contexts").update({ name: "Hack" }).eq("id", id).select("id");
    expect(member.data ?? []).toEqual([]);
    const byAdmin = await u.anna.db.from("contexts").update({ name: "Kunden AB" }).eq("id", id).select("id");
    expect(byAdmin.data).toEqual([{ id }]);
    must("unlink", await admin.from("meetings").update({ context_id: null }).eq("id", m.dev));
  });

  it("a person's group is always one of the same company's", async () => {
    const admin = adminClient();
    const other = must("other", await admin.rpc("create_foretag", { p_user: u.olle.id, p_name: "Annat AB", p_root_name: "VD", p_person_name: "Olle" })) as string;
    const otherRoot = (must("root", await admin.from("groups").select("id").eq("org_id", other).single()) as { id: string }).id;
    const insert = await admin.from("people").insert({ org_id: orgId, name: "Fel grupp", group_id: otherRoot });
    expect(insert.error?.message).toMatch(/not in this company/);
    const move = await admin.from("people").update({ group_id: otherRoot }).eq("org_id", orgId).eq("name", "Jonas");
    expect(move.error?.message).toMatch(/not in this company/);
    must("drop", await admin.from("orgs").delete().eq("id", other));
  });

  it("a task across the boundary waits for approval; the owner then sees only the reviewed task", async () => {
    const admin = adminClient();
    // A CEO meeting (root group) with a task for Kim at the bottom.
    const ceo = await meeting("anna", g.vd);
    const kim = (must("kim", await admin.from("people").select("id").eq("org_id", orgId).eq("name", "Kim").single()) as { id: string }).id;
    must(
      "notes",
      await admin.from("note_items").insert([
        { meeting_id: ceo, id: "h1", section: "action", text: "Förbered nedskärningen i Ekonomi", owner_person_id: kim, due: "fredag" },
        { meeting_id: ceo, id: "h2", section: "decision", text: "Hemligt beslut" },
      ]),
    );
    // The server resolves owners; a decision or someone else's person row passed along is ignored.
    const owners = [
      { item_id: "h1", person_id: kim },
      { item_id: "h2", person_id: kim },
    ];
    expect(must("create", await admin.rpc("create_task_handoffs", { p_meeting_id: ceo, p_owners: owners }))).toBe(1);
    expect(must("again", await admin.rpc("create_task_handoffs", { p_meeting_id: ceo, p_owners: owners }))).toBe(0);
    expect(await u.jonas.db.rpc("create_task_handoffs", { p_meeting_id: ceo, p_owners: owners }).then((r) => r.error)).not.toBeNull();

    // Pending: invisible to Kim, who can't approve it either.
    expect((await u.kim.db.from("task_handoffs").select("id").eq("meeting_id", ceo)).data).toEqual([]);
    const pending = must("pending", await u.anna.db.from("task_handoffs").select("id, status, text").eq("meeting_id", ceo)) as { id: string; status: string; text: string }[];
    expect(pending).toEqual([{ id: pending[0].id, status: "pending", text: "Förbered nedskärningen i Ekonomi" }]);
    expect((await u.kim.db.rpc("approve_task_handoff", { p_id: pending[0].id, p_text: "x" })).data).toBe(false);
    expect((await u.erik.db.rpc("approve_task_handoff", { p_id: pending[0].id, p_text: "x" })).data).toBe(false);

    // Approved with new wording: Kim reads exactly that, never the meeting, its title or notes.
    expect((await u.anna.db.rpc("approve_task_handoff", { p_id: pending[0].id, p_text: "Ta fram siffror till fredag" })).data).toBe(true);
    const mine = must("mine", await u.kim.db.from("task_handoffs").select("text, from_name, due, status")) as unknown[];
    expect(mine).toEqual([{ text: "Ta fram siffror till fredag", from_name: "Anna", due: "fredag", status: "approved" }]);
    expect((await u.kim.db.from("meetings").select("id, title").eq("id", ceo)).data).toEqual([]);
    expect((await u.kim.db.from("note_items").select("id").eq("meeting_id", ceo)).data).toEqual([]);
    expect((await u.kim.db.rpc("set_task_handoff_done", { p_id: pending[0].id, p_done: true })).data).toBe(true);
    expect((await u.maja.db.rpc("set_task_handoff_done", { p_id: pending[0].id, p_done: true })).data).toBe(false);
    // No client writes to the table.
    const write = await u.anna.db.from("task_handoffs").update({ status: "approved" }).eq("id", pending[0].id);
    expect(write.error?.message).toMatch(/permission denied/i);
  });

  it("a withdrawn handoff comes back when its owner loses sight again; a human drop stays dropped (0053)", async () => {
    const admin = adminClient();
    const x = await meeting("jonas", g.dev);
    const kim = (must("kim", await admin.from("people").select("id").eq("org_id", orgId).eq("name", "Kim").single()) as { id: string }).id;
    must("note", await admin.from("note_items").insert({ meeting_id: x, id: "x1", section: "action", text: "Kim tar fram budgeten", owner_person_id: kim }));
    const owners = [{ item_id: "x1", person_id: kim }];
    const create = async () => must("create", await admin.rpc("create_task_handoffs", { p_meeting_id: x, p_owners: owners })) as number;
    const rows = async () => must("rows", await admin.from("task_handoffs").select("id, status").eq("meeting_id", x)) as { id: string; status: string }[];
    const moveKim = async (group: string) => must("move", await admin.from("people").update({ group_id: group }).eq("id", kim));
    try {
      // Ekonomi can't see Utveckling: held.
      expect(await create()).toBe(1);
      // Kim moves up into Ledning: sees the meeting, the pending handoff is withdrawn.
      await moveKim(g.led);
      expect(await create()).toBe(0);
      expect(await rows()).toEqual([]);
      // Back in Ekonomi: held again.
      await moveKim(g.eko);
      expect(await create()).toBe(1);
      const [held] = await rows();
      expect(held.status).toBe("pending");
      // A human drop is a decision: it stays dropped through any later move.
      expect((await u.jonas.db.rpc("drop_task_handoff", { p_id: held.id })).data).toBe(true);
      await moveKim(g.led);
      await create();
      await moveKim(g.eko);
      expect(await create()).toBe(0);
      expect(await rows()).toEqual([{ id: held.id, status: "dropped" }]);
    } finally {
      await moveKim(g.eko);
    }
  });

  it("changes outside the app queue a reconcile; a deleted account's Drive permission is queued by id (0053)", async () => {
    const admin = adminClient();
    const queued = async () => ((await admin.from("foretag_reconcile_queue").select("org_id").eq("org_id", orgId)).data ?? []).length === 1;
    const clear = async () => must("clear", await admin.from("foretag_reconcile_queue").delete().eq("org_id", orgId));
    // A person moved or relinked.
    await clear();
    must("rename", await admin.from("people").update({ name: "Jonas" }).eq("org_id", orgId).eq("name", "Jonas"));
    expect(await queued()).toBe(false);
    must("move", await admin.from("people").update({ group_id: g.dev }).eq("org_id", orgId).eq("name", "Lisa"));
    expect(await queued()).toBe(false);
    must("move", await admin.from("people").update({ group_id: g.com }).eq("org_id", orgId).eq("name", "Lisa"));
    expect(await queued()).toBe(true);
    must("back", await admin.from("people").update({ group_id: g.dev }).eq("org_id", orgId).eq("name", "Lisa"));

    // An account's e-mail changed.
    const gone = await createTestUser("ftg-gone");
    must("join", await admin.from("org_members").insert({ org_id: orgId, user_id: gone.id, role: "member" }));
    await clear();
    expect((await admin.auth.admin.updateUserById(gone.id, { email: `ny-${gone.email}` })).error).toBeNull();
    expect(await queued()).toBe(true);

    // The account deleted: its share rows go with it, our permission on the Doc is queued by id.
    const docId = `doc-${crypto.randomUUID()}`;
    const shared = (must("m", await admin.from("meetings").insert({ org_id: orgId, started_by: u.anna.id, doc_id: docId, notes_tab_id: "t.0", status: "done", group_id: null }).select("id").single()) as { id: string }).id;
    must("share", await admin.from("meeting_doc_shares").insert({ meeting_id: shared, user_id: gone.id, email: gone.email, permission_id: "perm-gone" }));
    expect((await admin.auth.admin.deleteUser(gone.id)).error).toBeNull();
    const revocations = must("rev", await admin.from("doc_share_revocations").select("doc_id, owner_user_id, permission_id").eq("doc_id", docId));
    expect(revocations).toEqual([{ doc_id: docId, owner_user_id: u.anna.id, permission_id: "perm-gone" }]);
    // A share removed while the account exists (our own revoke) queues nothing.
    must("share2", await admin.from("meeting_doc_shares").insert({ meeting_id: shared, user_id: u.jonas.id, email: u.jonas.email, permission_id: "perm-jonas" }));
    must("unshare", await admin.from("meeting_doc_shares").delete().eq("meeting_id", shared).eq("user_id", u.jonas.id));
    expect((await admin.from("doc_share_revocations").select("permission_id").eq("doc_id", docId)).data).toEqual([{ permission_id: "perm-gone" }]);
    must("cleanup", await admin.from("doc_share_revocations").delete().eq("doc_id", docId));
  });

  it("placing a member account and archiving a group: admins only; archiving unplaces its people", async () => {
    const admin = adminClient();
    const extra = await createTestUser("ftg-extra");
    must("join", await admin.from("org_members").insert({ org_id: orgId, user_id: extra.id, role: "member" }));
    // A member can't place anyone; an admin places the account (its person row made on the way).
    expect((await u.jonas.db.rpc("place_member", { p_org_id: orgId, p_user_id: extra.id, p_group_id: g.dev, p_name: "Extra" })).data).toBeNull();
    const personId = (await u.anna.db.rpc("place_member", { p_org_id: orgId, p_user_id: extra.id, p_group_id: g.com, p_name: "Extra" })).data as string;
    expect(personId).toBeTruthy();
    const row = must("row", await admin.from("people").select("name, member_user_id, group_id").eq("id", personId).single());
    expect(row).toEqual({ name: "Extra", member_user_id: extra.id, group_id: g.com });
    // Placing again moves the same row.
    expect((await u.anna.db.rpc("place_member", { p_org_id: orgId, p_user_id: extra.id, p_group_id: g.eko, p_name: "Extra" })).data).toBe(personId);
    // Archive: never by a member, never with active child groups; a leaf archives and unplaces.
    const leaf = (must("leaf", await admin.from("groups").insert({ org_id: orgId, name: "Tillfällig", parent_group_id: g.eko }).select("id").single()) as { id: string }).id;
    expect((await u.anna.db.rpc("set_person_group", { p_person_id: personId, p_group_id: leaf })).data).toBe(true);
    expect((await u.jonas.db.rpc("archive_group", { p_id: leaf })).data).toBe(false);
    expect((await u.anna.db.rpc("archive_group", { p_id: g.eko })).data).toBe(false);
    expect((await u.anna.db.rpc("archive_group", { p_id: leaf })).data).toBe(true);
    expect(must("unplaced", await admin.from("people").select("group_id").eq("id", personId).single())).toEqual({ group_id: null });
    expect((await u.anna.db.rpc("set_person_group", { p_person_id: personId, p_group_id: leaf })).data).toBe(false);
  });

  it("several meetings at once in a company (one per starter); a förening stays at one", async () => {
    const admin = adminClient();
    const live = async (org: string, by: string, group: string | null) =>
      (must("live", await admin.from("meetings").insert({ org_id: org, started_by: by, doc_id: `doc-${crypto.randomUUID()}`, notes_tab_id: "t.0", status: "live", group_id: group }).select("id").single()) as { id: string }).id;
    const guard = async (id: string) => must("guard", await admin.rpc("guard_meeting_start_v2", { p_meeting_id: id, p_max_per_hour: 50 }));
    const dev = await live(orgId, u.lisa.id, g.dev);
    expect(await guard(dev)).toBe("ok");
    const com = await live(orgId, u.maja.id, g.com);
    expect(await guard(com)).toBe("ok");
    // Each is seen per the rule while both run.
    expect((await u.lisa.db.from("meetings").select("id").in("id", [dev, com])).data).toEqual([{ id: dev }]);
    expect((await u.maja.db.from("meetings").select("id").in("id", [dev, com])).data).toEqual([{ id: com }]);
    expect(((await u.sara.db.from("meetings").select("id").in("id", [dev, com])).data ?? []).length).toBe(2);
    // Still one per starter.
    const again = await live(orgId, u.lisa.id, g.dev);
    expect(await guard(again)).toBe("starter_busy");
    must("end", await admin.from("meetings").update({ status: "done" }).in("id", [dev, com]));

    // A förening: the second running meeting is refused (0027 unchanged).
    const first = await live(forening.id, u.olle.id, null);
    expect(await guard(first)).toBe("ok");
    must("fm", await admin.from("org_members").insert({ org_id: forening.id, user_id: u.kim.id, role: "member" }));
    const second = await live(forening.id, u.kim.id, null);
    expect(await guard(second)).toBe("org_busy");
    must("end", await admin.from("meetings").update({ status: "done" }).eq("id", first));
  });

  it("deleting a company cascades through its tree, meetings and held tasks", async () => {
    const admin = adminClient();
    const id = must("create", await admin.rpc("create_foretag", { p_user: u.olle.id, p_name: "Raderas AB", p_root_name: "VD", p_person_name: "Olle" })) as string;
    const root = (must("root", await admin.from("groups").select("id").eq("org_id", id).single()) as { id: string }).id;
    const child = (must("child", await admin.from("groups").insert({ org_id: id, name: "Team", parent_group_id: root }).select("id").single()) as { id: string }).id;
    must("meeting", await admin.from("meetings").insert({ org_id: id, started_by: u.olle.id, doc_id: "doc", notes_tab_id: "t.0", status: "done", group_id: child }));
    const del = await u.olle.db.from("orgs").delete().eq("id", id).select("id");
    expect(del.error).toBeNull();
    expect(del.data).toEqual([{ id }]);
    expect((await admin.from("groups").select("id").eq("org_id", id)).data).toEqual([]);
  });

  it("föreningar are unchanged: every member sees every meeting", async () => {
    // Every row of the förening (the stray-group private one and those other tests started).
    const all = must("all", await adminClient().from("meetings").select("id").eq("org_id", forening.id)) as { id: string }[];
    const { data } = await forening.member.db.from("meetings").select("id").eq("org_id", forening.id);
    expect((data ?? []).map((r) => r.id).sort()).toEqual(all.map((r) => r.id).sort());
    expect(all.map((r) => r.id)).toContain(forening.meeting);
  });
});
