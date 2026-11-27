import { beforeAll, describe, expect, it, vi } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";

// The MCP tools through the real handler, the real OAuth tables and the mcp_* read functions (0060),
// against the local stack: a Kommunikation member's token can't reach an Utveckling
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
  });
  return { ...mod, getEnv: () => env };
});

const { connectAs, resultOf, ORIGIN } = await import("@/test/mcp-kit");
const { dbStore } = await import("@/lib/mcp/store");
const { dbReader } = await import("@/lib/mcp/reader");
const { defaultToolDeps } = await import("@/lib/mcp/tools");
type McpDeps = import("@/lib/mcp/handler").McpDeps;
type Client = Awaited<ReturnType<typeof connectAs>>["client"];

const must = <T>(what: string, r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

describe.skipIf(!hasLocalSupabase)("MCP tools as the user (0060)", () => {
  let admin: ReturnType<typeof adminClient>;
  let deps: McpDeps;
  const makeDeps = (): McpDeps => ({
    origin: ORIGIN,
    store: dbStore(admin),
    reader: (userId) => dbReader(admin, userId),
    loadUser: async (id) => (await admin.auth.admin.getUserById(id)).data.user ?? null,
    enabled: () => true,
    toolDeps: defaultToolDeps,
  });
  let anna: TestUser, jonas: TestUser, maja: TestUser, fmember: TestUser;
  let majaPerson: string;
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
    majaPerson = (must("maja", await admin.from("people").select("id").eq("org_id", orgId).eq("name", "Maja").single()) as { id: string }).id;
    const meeting = async (org: string, by: string, groupId: string | null, title: string) =>
      (must("meeting", await admin.from("meetings").insert({ org_id: org, started_by: by, doc_id: "doc", notes_tab_id: "t.0", status: "done", group_id: groupId, title }).select("id").single()) as { id: string }).id;
    devMeeting = await meeting(orgId, jonas.id, dev, "Sprintmöte");
    allMeeting = await meeting(orgId, anna.id, null, "Hela företaget");
    must("roles", await admin.from("meetings").update({ agenda_roles: { "ag-1": "checkin" } }).eq("id", allMeeting));
    must(
      "notes",
      await admin.from("note_items").insert([
        { meeting_id: devMeeting, id: "t1", section: "action", text: "Maja gör bilden till lanseringen", owner: "Maja", deleted_by_human: false },
        { meeting_id: devMeeting, id: "d1", section: "decision", text: "Vi lanserar hemligprojektet", deleted_by_human: false },
        { meeting_id: allMeeting, id: "d1", section: "decision", text: "Julfest den 18 december", deleted_by_human: false },
        // Rows the app never shows: a line a human deleted, and one under a Må-runda item.
        { meeting_id: allMeeting, id: "n1", section: "note", text: "Raderad dolkstöt", deleted_by_human: true },
        { meeting_id: allMeeting, id: "n2", section: "note", text: "Mående dolkstöt", anchor: "ag-1", deleted_by_human: false },
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
    const spaces = await call(client, "list_spaces");
    expect((spaces.data as { spaces: { org_id: string }[] }).spaces.map((o) => o.org_id)).toContain(orgId);
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
    await expect(client.callTool({ name: "list_spaces", arguments: {} })).rejects.toThrow();
  });

  it("every mcp_* function refuses what the user can't see (and only the service role may call them)", async () => {
    // A Privat space of Jonas's, and a pending handoff for Maja from the Utveckling meeting.
    const privOrg = (must("privat", await admin.from("orgs").insert({ name: "Privat", kind: "privat", created_by: jonas.id, share_transcript: false, summary_mode: "off" }).select("id").single()) as { id: string }).id;
    await admin.from("org_members").upsert({ org_id: privOrg, user_id: jonas.id, role: "admin" }, { onConflict: "org_id,user_id", ignoreDuplicates: true });
    const ctxId = (must("context", await admin.from("contexts").insert({ org_id: privOrg, name: "TDDE15" }).select("id").single()) as { id: string }).id;
    const privMeeting = (must("pm", await admin.from("meetings").insert({ org_id: privOrg, started_by: jonas.id, doc_id: "doc", notes_tab_id: "t.0", status: "done", context_id: ctxId }).select("id").single()) as { id: string }).id;
    must("summary", await admin.from("private_summaries").insert({ meeting_id: privMeeting, context_id: ctxId, summary: "Hemlig tenta-plan" }));
    const taskId = (must("task", await admin.from("context_tasks").insert({ context_id: ctxId, meeting_id: privMeeting, text: "Läs kapitel 3" }).select("id").single()) as { id: string }).id;
    const handoff = (must(
      "handoff",
      await admin.from("task_handoffs").insert({ org_id: orgId, meeting_id: devMeeting, item_id: "t1", owner_person_id: majaPerson, text: "Maja gör bilden", status: "pending" }).select("id").single(),
    ) as { id: string }).id;

    const as = (user: TestUser) => async (fn: string, args: Record<string, unknown>) => {
      const { data, error } = await admin.rpc(fn, { p_user: user.id, ...args });
      if (error) throw new Error(`${fn}: ${error.message}`);
      return data as unknown;
    };
    const maja_ = as(maja);
    const jonas_ = as(jonas);
    const all = { p_org: null, p_ids: null as string[] | null, p_from: null, p_to: null, p_done: false, p_limit: 100 };

    // Positive controls: Jonas sees his own.
    expect(await jonas_("mcp_meetings", { ...all, p_ids: [devMeeting, privMeeting] })).toHaveLength(2);
    expect(await jonas_("mcp_note_items", { p_meeting_ids: [devMeeting], p_like: null })).toHaveLength(2);
    expect(await jonas_("mcp_private_summaries", { p_meeting_ids: [privMeeting], p_like: null })).toHaveLength(1);
    expect(await jonas_("mcp_context_tasks", { p_context_ids: [ctxId] })).toHaveLength(1);
    expect(await jonas_("mcp_contexts", { p_org_ids: [privOrg] })).toHaveLength(1);
    expect(await jonas_("mcp_handoffs", { p_org_ids: [orgId] })).toHaveLength(1); // the starter approves it

    // Maja: nothing of Utveckling, nothing of Jonas's Privat, no pending handoff (not approved yet).
    expect(await maja_("mcp_meetings", { ...all, p_ids: [devMeeting, privMeeting] })).toEqual([]);
    expect(await maja_("mcp_meetings", { ...all, p_org: orgId })).not.toContainEqual(expect.objectContaining({ id: devMeeting }));
    expect(await maja_("mcp_note_items", { p_meeting_ids: [devMeeting, privMeeting], p_like: null })).toEqual([]);
    expect(await maja_("mcp_private_summaries", { p_meeting_ids: [privMeeting], p_like: null })).toEqual([]);
    expect(await maja_("mcp_context_tasks", { p_context_ids: [ctxId] })).toEqual([]);
    expect(await maja_("mcp_contexts", { p_org_ids: [privOrg] })).toEqual([]);
    expect(await maja_("mcp_people", { p_org_ids: [privOrg] })).toEqual([]);
    expect(await maja_("mcp_handoffs", { p_org_ids: [orgId] })).toEqual([]);
    expect((await maja_("mcp_orgs", {})) as { id: string }[]).not.toContainEqual(expect.objectContaining({ id: privOrg }));
    expect(await maja_("mcp_set_privat_task_done", { p_id: taskId, p_done: true })).toBe(false);
    expect(await maja_("mcp_set_handoff_done", { p_id: handoff, p_done: true })).toBe(false);
    expect((must("still open", await admin.from("context_tasks").select("done").eq("id", taskId).single()) as { done: boolean }).done).toBe(false);

    // Approved: now Maja sees the task (never the meeting) and may tick it.
    must("approve", await admin.from("task_handoffs").update({ status: "approved" }).eq("id", handoff));
    expect(((await maja_("mcp_handoffs", { p_org_ids: [orgId] })) as { id: string }[]).map((h) => h.id)).toEqual([handoff]);
    expect(await maja_("mcp_meetings", { ...all, p_ids: [devMeeting] })).toEqual([]);
    expect(await maja_("mcp_set_handoff_done", { p_id: handoff, p_done: true })).toBe(true);
    expect(await jonas_("mcp_set_privat_task_done", { p_id: taskId, p_done: true })).toBe(true);

    // A signed-in client can't call them at all (no p_user spoofing).
    for (const fn of ["mcp_orgs", "mcp_meetings", "mcp_note_items", "mcp_people", "mcp_handoffs", "mcp_set_handoff_done", "mcp_act_as"]) {
      const { error } = await maja.db.rpc(fn, { p_user: jonas.id });
      expect(error, fn).not.toBeNull();
    }
  });

  it("Privat: the owner finds and reads their own recordings and tasks; another user never gets them", async () => {
    // Anna's Privat space: a "Kurs" context with one recording, its summary and a task.
    const priv = (must("privat", await admin.from("orgs").insert({ name: "Privat", kind: "privat", created_by: anna.id, share_transcript: false, summary_mode: "off" }).select("id").single()) as { id: string }).id;
    await admin.from("org_members").upsert({ org_id: priv, user_id: anna.id, role: "admin" }, { onConflict: "org_id,user_id", ignoreDuplicates: true });
    const course = (must("ctx", await admin.from("contexts").insert({ org_id: priv, name: "Kurs TDDE15" }).select("id").single()) as { id: string }).id;
    const rec = (must("rec", await admin.from("meetings").insert({ org_id: priv, started_by: anna.id, doc_id: "doc", notes_tab_id: "t.0", status: "done", context_id: course }).select("id").single()) as { id: string }).id;
    must("sum", await admin.from("private_summaries").insert({ meeting_id: rec, context_id: course, summary: "Föreläsning om bayesiska nätverk", decisions: ["Läs kapitel 4"], people: ["Anna"] }));
    const task = (must("task", await admin.from("context_tasks").insert({ context_id: course, meeting_id: rec, text: "Gör labb 2" }).select("id").single()) as { id: string }).id;

    const { client: own } = await connectAs(anna.id, deps);
    const spaces = (await call(own, "list_spaces")).data as { spaces: { org_id: string; kind: string; contexts?: { context_id: string; name: string }[] }[] };
    expect(spaces.spaces.find((s) => s.org_id === priv)).toMatchObject({ kind: "privat", contexts: [{ context_id: course, name: "Kurs TDDE15" }] });
    const hit = (await call(own, "search_meetings", { query: "bayesiska", context_id: course })).data as { meetings: { meeting_id: string; title: string }[] };
    expect(hit.meetings).toMatchObject([{ meeting_id: rec, title: "Kurs TDDE15" }]);
    expect((await call(own, "get_meeting", { meeting_id: rec })).data).toMatchObject({
      org_kind: "privat",
      summary: "Föreläsning om bayesiska nätverk",
      decisions: ["Läs kapitel 4"],
      tasks: [{ task_id: `p:${task}`, text: "Gör labb 2", done: false }],
    });
    const mine = (await call(own, "my_tasks")).data as { tasks: { task_id: string; context?: string }[] };
    expect(mine.tasks).toContainEqual(expect.objectContaining({ task_id: `p:${task}`, context: "Kurs TDDE15" }));
    expect((await call(own, "prepare_agenda", { org_id: priv, point: "X" })).isError).toBe(true);

    // Jonas: never Anna's recording, summary or task, whatever he asks for.
    const { client: other } = await connectAs(jonas.id, deps);
    expect(((await call(other, "search_meetings", { query: "bayesiska" })).data as { meetings: unknown[] }).meetings).toEqual([]);
    expect(((await call(other, "search_meetings", { context_id: course })).data as { meetings: unknown[] }).meetings).toEqual([]);
    const get = await call(other, "get_meeting", { meeting_id: rec });
    expect(get.isError).toBe(true);
    expect(get.text).not.toContain("bayesiska");
    expect(JSON.stringify((await call(other, "my_tasks", { status: "all" })).data)).not.toContain(task);
    expect((await call(other, "complete_task", { task_id: `p:${task}` })).isError).toBe(true);
    expect((must("open", await admin.from("context_tasks").select("done").eq("id", task).single()) as { done: boolean }).done).toBe(false);
    expect((await call(own, "complete_task", { task_id: `p:${task}` })).data).toMatchObject({ done: true });
    await own.close();
    await other.close();
  });
});
