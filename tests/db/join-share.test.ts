import { beforeAll, describe, expect, it, vi } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { createOrg } from "@/lib/db/orgs";

// 0054: a new member's Doc sharing on join (shareOrgDocsWithNewMember) shares only the Docs of
// meetings they can see by the database's own rule (visible_meeting_ids): never a Privat möte, and
// in a förening with groups never another group's meeting. Google is faked.

const shared = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/supabase/admin", async () => ({ supabaseAdmin: (await import("@/test/local-supabase")).adminClient }));
vi.mock("@/lib/google/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/client")>()),
  getGoogleAuth: async () => ({}),
}));
vi.mock("@/lib/google/docs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/docs")>()),
  driveApi: () => ({
    permissions: {
      list: async () => ({ data: { permissions: [] } }),
      create: async (a: { fileId: string }) => (shared.push(a.fileId), { data: { id: `perm-${a.fileId}` } }),
    },
  }),
}));

const { shareOrgDocsWithNewMember } = await import("@/lib/docs/access");

const must = <T>(what: string, r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

describe.skipIf(!hasLocalSupabase)("join: Docs of visible meetings only (0054)", () => {
  let starter: TestUser;
  let joiner: TestUser;

  beforeAll(async () => {
    [starter, joiner] = await Promise.all([createTestUser("jsstarter"), createTestUser("jsjoiner")]);
  });

  async function setup(name: string): Promise<string> {
    const r = await createOrg(starter.db, name);
    if (!r.ok) throw new Error("org setup failed");
    must("join", await adminClient().from("org_members").insert({ org_id: r.id, user_id: joiner.id, role: "member" }));
    return r.id;
  }

  async function meeting(orgId: string, doc: string, opts: { group?: string | null; private?: boolean } = {}) {
    must(
      "meeting",
      await adminClient()
        .from("meetings")
        .insert({ org_id: orgId, started_by: starter.id, doc_id: doc, notes_tab_id: "t.0", status: "done", app_created_doc: true, group_id: opts.group ?? null, private: opts.private ?? false }),
    );
  }

  it("groups off: every Doc but a Privat möte's", async () => {
    const orgId = await setup("Delning utan grupper");
    await meeting(orgId, "doc-open");
    await meeting(orgId, "doc-private", { private: true });
    shared.length = 0;
    expect(await shareOrgDocsWithNewMember(orgId, { id: joiner.id, email: joiner.email })).toBe(1);
    expect(shared).toEqual(["doc-open"]);
  });

  it("groups on: the joiner's own group and Hela föreningen, never a cousin group or a Privat möte", async () => {
    const orgId = await setup("Delning med grupper");
    expect((await starter.db.rpc("set_org_groups", { p_org_id: orgId, p_on: true, p_root_name: "Styrelsen" })).data).toBe(true);
    const root = (must("root", await starter.db.from("groups").select("id").eq("org_id", orgId).single()) as { id: string }).id;
    const dev = must("dev", await starter.db.rpc("set_group", { p_org_id: orgId, p_id: null, p_name: "Utveckling", p_parent: root })) as string;
    const com = must("com", await starter.db.rpc("set_group", { p_org_id: orgId, p_id: null, p_name: "Kommunikation", p_parent: root })) as string;
    expect(must("place", await starter.db.rpc("place_member", { p_org_id: orgId, p_user_id: joiner.id, p_group_id: dev, p_name: "Ny" }))).toBeTruthy();
    await meeting(orgId, "doc-all");
    await meeting(orgId, "doc-dev", { group: dev });
    await meeting(orgId, "doc-com", { group: com });
    await meeting(orgId, "doc-board", { group: root });
    await meeting(orgId, "doc-dev-private", { group: dev, private: true });
    shared.length = 0;
    expect(await shareOrgDocsWithNewMember(orgId, { id: joiner.id, email: joiner.email })).toBe(2);
    expect(shared.sort()).toEqual(["doc-all", "doc-dev"]);
  });
});
