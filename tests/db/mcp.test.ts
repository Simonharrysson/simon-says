import { beforeAll, describe, expect, it, vi } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";

// The MCP tools through the real handler, the real OAuth tables (0056) and the user's RLS-scoped
// client, against the local stack: a Kommunikation member's token can't reach an Utveckling
// meeting (0050 tree), a removed förening member loses their meetings, a revoked grant stops at
// once, and every call leaves one audit row with ids only.

vi.mock("@/lib/env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/env")>();
  const { testEnv } = await import("@/test/env");
  const env = mod.parseEnv({
    ...testEnv,
    SUPABASE_URL: process.env.LOCAL_SUPABASE_API_URL ?? "http://127.0.0.1:54321",
    SUPABASE_ANON_KEY: process.env.LOCAL_SUPABASE_ANON_KEY ?? "anon",
    SUPABASE_SERVICE_ROLE_KEY: process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY ?? "service",
    SUPABASE_JWT_SECRET: process.env.LOCAL_SUPABASE_JWT_SECRET ?? "secret",
  });
  return { ...mod, getEnv: () => env };
});

const { connectAs, resultOf, ORIGIN } = await import("@/test/mcp-kit");
const { dbStore } = await import("@/lib/mcp/store");
const { defaultToolDeps } = await import("@/lib/mcp/tools");
type McpDeps = import("@/lib/mcp/handler").McpDeps;
type Client = Awaited<ReturnType<typeof connectAs>>["client"];

const must = <T>(what: string, r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

describe.skipIf(!hasLocalSupabase)("MCP tools as the user (0056, RLS)", () => {
  let admin: ReturnType<typeof adminClient>;
  let deps: McpDeps;
  const makeDeps = (): McpDeps => ({
    origin: ORIGIN,
    supabaseUrl: process.env.LOCAL_SUPABASE_API_URL!,
    anonKey: process.env.LOCAL_SUPABASE_ANON_KEY!,
    jwtSecret: process.env.LOCAL_SUPABASE_JWT_SECRET,
    store: dbStore(admin),
    loadUser: async (id) => (await admin.auth.admin.getUserById(id)).data.user ?? null,
    allowed: () => true,
    toolDeps: defaultToolDeps,
  });
  let anna: TestUser, jonas: TestUser, maja: TestUser, fmember: TestUser;
  let orgId: string, devMeeting: string, allMeeting: string, fOrg: string, fMeeting: string;
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => resultOf(await c.callTool({ name, arguments: args }));

  beforeAll(async () => {
    admin = adminClient();
    deps = makeDeps();
    [anna, jonas, maja, fmember] = await Promise.all(["mcp-anna", "mcp-jonas", "mcp-maja", "mcp-fmember"].map((l) => createTestUser(l)));
    orgId = must("create", await admin.rpc("create_foretag", { p_user: anna.id, p_name: "MCP-bolaget", p_root_name: "VD", p_person_name: "Anna" })) as string;
    const root = (must("root", await admin.from("groups").select("id").eq("org_id", orgId).single()) as { id: string }).id;
    const group = async (name: string) => (must(name, await admin.from("groups").insert({ org_id: orgId, name, parent_group_id: root }).select("id").single()) as { id: string }).id;
    const [dev, com] = [await group("Utveckling"), await group("Kommunikation")];
    must("members", await admin.from("org_members").insert([jonas, maja].map((u) => ({ org_id: orgId, user_id: u.id, role: "member" }))));
    must(
      "people",
      await admin.from("people").insert([
        { org_id: orgId, name: "Jonas", member_user_id: jonas.id, group_id: dev },
        { org_id: orgId, name: "Maja", member_user_id: maja.id, group_id: com },
      ]),
    );
    const meeting = async (org: string, by: string, groupId: string | null, title: string) =>
      (must("meeting", await admin.from("meetings").insert({ org_id: org, started_by: by, doc_id: "doc", notes_tab_id: "t.0", status: "done", group_id: groupId, title }).select("id").single()) as { id: string }).id;
    devMeeting = await meeting(orgId, jonas.id, dev, "Sprintmöte");
    allMeeting = await meeting(orgId, anna.id, null, "Hela företaget");
    must("roles", await admin.from("meetings").update({ agenda_roles: { "ag-1": "checkin" } }).eq("id", allMeeting));
    must(
      "notes",
      await admin.from("note_items").insert([
        { meeting_id: devMeeting, id: "t1", section: "action", text: "Maja gör bilden till lanseringen", owner: "Maja" },
        { meeting_id: devMeeting, id: "d1", section: "decision", text: "Vi lanserar hemligprojektet" },
        { meeting_id: allMeeting, id: "d1", section: "decision", text: "Julfest den 18 december" },
        // Rows the app never shows: a line a human deleted, and one under a Må-runda item.
        { meeting_id: allMeeting, id: "n1", section: "note", text: "Raderad dolkstöt", deleted_by_human: true },
        { meeting_id: allMeeting, id: "n2", section: "note", text: "Mående dolkstöt", anchor: "ag-1" },
      ]),
    );
    fOrg = (must("forening", await admin.from("orgs").insert({ name: "MCP-föreningen", created_by: anna.id }).select("id").single()) as { id: string }).id;
    must("fmember", await admin.from("org_members").insert({ org_id: fOrg, user_id: fmember.id, role: "member" }));
    fMeeting = await meeting(fOrg, anna.id, null, "Styrelsemöte");
    must("fnote", await admin.from("note_items").insert({ meeting_id: fMeeting, id: "d1", section: "decision", text: "Budgeten antas" }));
  });

  it("a Kommunikation member's token can't find or read an Utveckling meeting", async () => {
    const { client } = await connectAs(maja.id, deps);
    const all = await call(client, "search_meetings", { org_id: orgId });
    const ids = (all.data as { meetings: { meeting_id: string }[] }).meetings.map((m) => m.meeting_id);
    expect(ids).toContain(allMeeting);
    expect(ids).not.toContain(devMeeting);
    const hit = await call(client, "search_meetings", { query: "hemligprojektet" });
    expect((hit.data as { meetings: unknown[] }).meetings).toEqual([]);
    const get = await call(client, "get_meeting", { meeting_id: devMeeting });
    expect(get.isError).toBe(true);
    expect(get.text).not.toContain("hemligprojektet");
    const tick = await call(client, "complete_task", { task_id: `n:${devMeeting}:t1` });
    expect(tick.isError).toBe(true);
    const done = must("t1", await admin.from("note_items").select("done").eq("meeting_id", devMeeting).eq("id", "t1").single()) as { done: boolean };
    expect(done.done).toBe(false);
    await client.close();
  });

  it("the Utveckling member's token reads it", async () => {
    const { client } = await connectAs(jonas.id, deps);
    const hit = await call(client, "search_meetings", { query: "hemligprojektet" });
    expect((hit.data as { meetings: { meeting_id: string; match: string }[] }).meetings).toMatchObject([{ meeting_id: devMeeting, match: "Vi lanserar hemligprojektet" }]);
    const get = await call(client, "get_meeting", { meeting_id: devMeeting });
    expect(get.isError).toBe(false);
    expect(get.data).toMatchObject({ title: "Sprintmöte", org_kind: "foretag", decisions: ["Vi lanserar hemligprojektet"] });
    // Never a hit from a deleted line or a Må-runda row (the app's own visible() rule).
    expect((await call(client, "search_meetings", { query: "dolkstöt" })).data).toMatchObject({ meetings: [] });
    const orgs = await call(client, "list_orgs");
    expect((orgs.data as { orgs: { org_id: string }[] }).orgs.map((o) => o.org_id)).toContain(orgId);
    await client.close();
  });

  it("a member removed from a förening loses its meetings on the next call", async () => {
    const { client } = await connectAs(fmember.id, deps);
    expect((await call(client, "get_meeting", { meeting_id: fMeeting })).data).toMatchObject({ decisions: ["Budgeten antas"] });
    must("remove", await admin.from("org_members").delete().eq("org_id", fOrg).eq("user_id", fmember.id));
    expect((await call(client, "get_meeting", { meeting_id: fMeeting })).isError).toBe(true);
    await client.close();
  });

  it("Återkalla stops the token at once; the audit keeps ids only", async () => {
    const { client, provider } = await connectAs(anna.id, deps);
    await call(client, "search_meetings", { query: "julfest" });
    await call(client, "get_meeting", { meeting_id: allMeeting });
    const grants = must("grants", await anna.db.from("mcp_grants").select("id, client_name, revoked_at")) as { id: string; client_name: string }[];
    expect(grants).toHaveLength(1);
    expect(grants[0].client_name).toBe("Claude (test)");
    const audit = must("audit", await anna.db.from("mcp_audit").select("tool, ids, ok").order("at")) as { tool: string; ids: Record<string, string> }[];
    expect(audit.map((a) => a.tool)).toEqual(["search_meetings", "get_meeting"]);
    expect(audit[1].ids).toMatchObject({ meeting_id: allMeeting, org_id: orgId });
    expect(JSON.stringify(audit)).not.toMatch(/julfest/i);
    // Another user sees neither.
    expect(must("other", await jonas.db.from("mcp_audit").select("id").eq("grant_id", grants[0].id))).toEqual([]);
    expect(must("other grants", await jonas.db.from("mcp_grants").select("id").eq("id", grants[0].id))).toEqual([]);
    // Tokens and codes are hashes only, never readable by a client.
    expect((await anna.db.from("mcp_tokens").select("token_hash")).data ?? []).toEqual([]);
    const stored = must("tokens", await admin.from("mcp_tokens").select("token_hash").eq("grant_id", grants[0].id)) as { token_hash: string }[];
    expect(stored.map((s) => s.token_hash)).not.toContain(provider.saved!.access_token);

    expect(must("revoke", await jonas.db.rpc("revoke_mcp_grant", { p_grant_id: grants[0].id }))).toBe(false);
    expect(must("revoke", await anna.db.rpc("revoke_mcp_grant", { p_grant_id: grants[0].id }))).toBe(true);
    await expect(client.callTool({ name: "list_orgs", arguments: {} })).rejects.toThrow();
  });
});
