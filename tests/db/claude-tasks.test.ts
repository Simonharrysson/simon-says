import { beforeAll, describe, expect, it, vi } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";

// Agent tasks and company memory (0065) through the real MCP handler and the mcp_* functions,
// against the local stack: the Företag tree decides which agent tasks a user lists, only the
// assigner (the meeting's runner) or an admin moves one, memory drafts use only meetings every
// member can see, get_org_memory hides a line whose source the reader can't see, and no signed-in
// client can call the functions or write the tables.

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
const { draftMeetings, refreshMemory, saveMemoryEdits, loadMemory } = await import("@/lib/memory/store");
type McpDeps = import("@/lib/mcp/handler").McpDeps;
type Client = Awaited<ReturnType<typeof connectAs>>["client"];

const must = <T>(what: string, r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

type Brief = { task_id: string; task: string; status: string; note: string | null; can_update: boolean; context: { decisions: string[] } };

describe.skipIf(!hasLocalSupabase)("agent tasks and org memory (0065)", () => {
  let admin: ReturnType<typeof adminClient>;
  let deps: McpDeps;
  let anna: TestUser, jonas: TestUser, maja: TestUser, pelle: TestUser;
  let orgId: string, devMeeting: string, allMeeting: string;
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => resultOf(await c.callTool({ name, arguments: args }));
  const statusRow = async (meeting: string, item: string) =>
    (must("status", await admin.from("agent_task_status").select("status, note").eq("meeting_id", meeting).eq("item_id", item).maybeSingle()) as { status: string; note: string | null } | null);

  beforeAll(async () => {
    admin = adminClient();
    deps = {
      origin: ORIGIN,
      store: dbStore(admin),
      reader: (userId) => dbReader(admin, userId),
      loadUser: async (id) => (await admin.auth.admin.getUserById(id)).data.user ?? null,
      enabled: () => true,
      toolDeps: defaultToolDeps,
    };
    [anna, jonas, maja, pelle] = await Promise.all(["ct-anna", "ct-jonas", "ct-maja", "ct-pelle"].map((l) => createTestUser(l)));
    orgId = must("create", await admin.rpc("create_foretag", { p_user: anna.id, p_name: "Agentbolaget", p_root_name: "VD", p_person_name: "Anna" })) as string;
    const root = (must("root", await admin.from("groups").select("id").eq("org_id", orgId).single()) as { id: string }).id;
    const group = async (name: string) => (must(name, await admin.from("groups").insert({ org_id: orgId, name, parent_group_id: root }).select("id").single()) as { id: string }).id;
    const [dev, com] = [await group("Utveckling"), await group("Kommunikation")];
    must("members", await admin.from("org_members").insert([jonas, maja, pelle].map((u) => ({ org_id: orgId, user_id: u.id, role: "member" }))));
    must(
      "people",
      await admin.from("people").insert([
        { org_id: orgId, name: "Jonas", member_user_id: jonas.id, group_id: dev },
        { org_id: orgId, name: "Pelle", member_user_id: pelle.id, group_id: dev },
        { org_id: orgId, name: "Maja", member_user_id: maja.id, group_id: com },
      ]),
    );
    const meeting = async (by: string, groupId: string | null, title: string) =>
      (must("meeting", await admin.from("meetings").insert({ org_id: orgId, started_by: by, doc_id: "doc", notes_tab_id: "t.0", status: "done", group_id: groupId, title }).select("id").single()) as { id: string }).id;
    devMeeting = await meeting(jonas.id, dev, "Sprintmöte");
    allMeeting = await meeting(anna.id, null, "Hela företaget");
    must(
      "notes",
      await admin.from("note_items").insert([
        { meeting_id: devMeeting, id: "t1", section: "action", kind: "task", text: "Sammanställ hemligprojektets offerter", owner: "Claude", done_when: "En tabell i Driven", position: 0 },
        { meeting_id: devMeeting, id: "d1", section: "decision", kind: "decision", text: "Vi lanserar hemligprojektet i mars", position: 1 },
        { meeting_id: allMeeting, id: "a1", section: "action", kind: "task", text: "Skriv ett utkast till julbrevet", owner: "AI", position: 0 },
        { meeting_id: allMeeting, id: "a2", section: "action", kind: "task", text: "Boka julbordet", owner: "Maja", position: 1 },
        { meeting_id: allMeeting, id: "d1", section: "decision", kind: "decision", text: "Julfest den 18 december", position: 2 },
      ]),
    );
  });

  it("lists the agent tasks of meetings the user can see, as briefs (never an Utveckling one for Kommunikation)", async () => {
    const { client } = await connectAs(maja.id, deps);
    const r = await call(client, "list_agent_tasks");
    const tasks = (r.data as { tasks: Brief[] }).tasks;
    expect(tasks.map((t) => t.task_id)).toEqual([`n:${allMeeting}:a1`]);
    expect(tasks[0]).toMatchObject({ task: "Skriv ett utkast till julbrevet", status: "open", can_update: false, context: { decisions: ["Julfest den 18 december"] } });
    expect(r.text).not.toContain("hemligprojekt");
    await client.close();

    const { client: dev } = await connectAs(jonas.id, deps);
    const mine = ((await call(dev, "list_agent_tasks")).data as { tasks: Brief[] }).tasks;
    expect(mine.map((t) => t.task_id).sort()).toEqual([`n:${allMeeting}:a1`, `n:${devMeeting}:t1`].sort());
    expect(mine.find((t) => t.task_id === `n:${devMeeting}:t1`)).toMatchObject({ can_update: true, context: { decisions: ["Vi lanserar hemligprojektet i mars"] } });
    await dev.close();
  });

  it("only the assigner or an admin moves an agent task; done ticks it like the app", async () => {
    const task = `n:${devMeeting}:t1`;
    // Maja can't see the meeting; Pelle sees it but neither ran it nor is an admin.
    for (const u of [maja, pelle]) {
      const { client } = await connectAs(u.id, deps);
      expect((await call(client, "update_agent_task", { task_id: task, status: "in_progress", note: "kapat" })).isError).toBe(true);
      await client.close();
    }
    expect(await statusRow(devMeeting, "t1")).toBeNull();
    // Not Claude's: refused even for an admin.
    const { client: boss } = await connectAs(anna.id, deps);
    expect((await call(boss, "update_agent_task", { task_id: `n:${allMeeting}:a2`, status: "in_progress" })).isError).toBe(true);
    await boss.close();

    const { client } = await connectAs(jonas.id, deps);
    expect((await call(client, "update_agent_task", { task_id: task, status: "blocked", note: "Saknar priset från leverantör B" })).data).toMatchObject({ status: "blocked" });
    expect(await statusRow(devMeeting, "t1")).toEqual({ status: "blocked", note: "Saknar priset från leverantör B" });
    const done = await call(client, "update_agent_task", { task_id: task, status: "done", note: "Tabellen ligger i Driven" });
    expect(done.data).toMatchObject({ status: "done" });
    expect((must("row", await admin.from("note_items").select("done").eq("meeting_id", devMeeting).eq("id", "t1").single()) as { done: boolean }).done).toBe(true);
    expect(await statusRow(devMeeting, "t1")).toEqual({ status: "done", note: "Tabellen ligger i Driven" });
    expect(((await call(client, "list_agent_tasks")).data as { tasks: Brief[] }).tasks.map((t) => t.task_id)).not.toContain(task);
    expect(((await call(client, "list_agent_tasks", { status: "done" })).data as { tasks: Brief[] }).tasks).toMatchObject([{ task_id: task, note: "Tabellen ligger i Driven" }]);
    // The audit keeps ids, never the note.
    const audit = must("audit", await jonas.db.from("mcp_audit").select("tool, ids").eq("tool", "update_agent_task")) as { ids: Record<string, string> }[];
    expect(JSON.stringify(audit)).not.toMatch(/leverantör|Driven/);
    await client.close();

    // The status row is readable by those who see the meeting, and only them.
    expect(must("jonas reads", await jonas.db.from("agent_task_status").select("item_id").eq("meeting_id", devMeeting))).toHaveLength(1);
    expect(must("maja reads", await maja.db.from("agent_task_status").select("item_id").eq("meeting_id", devMeeting))).toEqual([]);
  });

  it("a memory draft uses only meetings every member can see", async () => {
    const ids = ((must("sources", await admin.rpc("org_memory_sources", { p_org: orgId, p_limit: 40 })) as { id: string }[]) ?? []).map((m) => m.id);
    expect(ids).toContain(allMeeting);
    expect(ids).not.toContain(devMeeting);
    const meetings = await draftMeetings(admin, orgId);
    expect(JSON.stringify(meetings)).not.toContain("hemligprojekt");
    expect(meetings.find((m) => m.id === allMeeting)?.content.decisions).toEqual(["Julfest den 18 december"]);

    // Uppdatera (a fake Claude): a source outside the set is dropped with its line; the draft is saved as the admin.
    const fake = async () => ({
      ok: true as const,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 },
      value: {
        lines: [
          { section: "decisions" as const, text: "Julfesten hålls i december", sources: [allMeeting] },
          { section: "priorities" as const, text: "Hemligprojektet lanseras i mars", sources: [devMeeting] },
        ],
      },
    });
    const org = { id: orgId, name: "Agentbolaget" };
    expect(await refreshMemory(maja.db, org, maja.id, { admin, oneShot: fake as never, now: new Date() })).toMatchObject({ ok: false });
    expect(await refreshMemory(anna.db, org, anna.id, { admin, oneShot: fake as never, now: new Date() })).toEqual({ ok: true, lines: 1, meetings: 1 });
    const saved = await loadMemory(anna.db, orgId);
    expect(saved.lines.map((l) => l.text)).toEqual(["Julfesten hålls i december"]);
    // Cooldown: a second Uppdatera right away is refused.
    expect(await refreshMemory(anna.db, org, anna.id, { admin, oneShot: fake as never, now: new Date() })).toEqual({ ok: false, reason: "cooldown" });
    // A member can't edit; the admin can.
    expect(await saveMemoryEdits(maja.db, orgId, maja.id, [{ section: "glossary", text: "MVP = minsta möjliga produkt" }])).toBe(false);
    expect(await saveMemoryEdits(anna.db, orgId, anna.id, [...saved.lines.map((l) => ({ id: l.id, section: l.section, text: l.text })), { section: "glossary", text: "MVP = minsta möjliga produkt" }])).toBe(true);
    expect((await loadMemory(maja.db, orgId)).lines.map((l) => l.text)).toEqual(["Julfesten hålls i december", "MVP = minsta möjliga produkt"]);
  });

  it("get_org_memory: a line with a source the reader can't see is left out", async () => {
    must(
      "memory",
      await admin.from("org_memory").upsert(
        {
          org_id: orgId,
          lines: [
            { id: "l1", section: "decisions", text: "Julfest varje december", sources: [allMeeting], edited: false },
            { id: "l2", section: "priorities", text: "Hemligprojektet först", sources: [devMeeting], edited: true },
            { id: "l3", section: "glossary", text: "VD = verkställande direktör", sources: [], edited: true },
          ],
        },
        { onConflict: "org_id" },
      ),
    );
    const text = async (u: TestUser) => {
      const { client } = await connectAs(u.id, deps);
      const r = await call(client, "get_org_memory", { org_id: orgId });
      await client.close();
      return r.text;
    };
    const forMaja = await text(maja);
    expect(forMaja).toContain("Julfest varje december");
    expect(forMaja).toContain("VD = verkställande direktör");
    expect(forMaja).not.toContain("Hemligprojektet");
    expect(await text(jonas)).toContain("Hemligprojektet först");
  });

  it("no signed-in client calls the new functions or writes the tables", async () => {
    for (const [fn, args] of [
      ["mcp_agent_task_status", { p_user: jonas.id, p_meeting_ids: [devMeeting] }],
      ["mcp_set_agent_task", { p_user: jonas.id, p_meeting: devMeeting, p_item: "t1", p_status: "in_progress", p_note: null }],
      ["mcp_org_memory", { p_user: jonas.id, p_org: orgId }],
      ["org_memory_sources", { p_org: orgId, p_limit: 40 }],
    ] as const) {
      const { error } = await maja.db.rpc(fn, args);
      expect(error, fn).not.toBeNull();
    }
    expect((await jonas.db.from("agent_task_status").insert({ meeting_id: allMeeting, item_id: "a1", status: "done" })).error).not.toBeNull();
    expect((await jonas.db.from("agent_task_status").update({ status: "blocked" }).eq("meeting_id", devMeeting).select("item_id")).data ?? []).toEqual([]);
    expect((await maja.db.from("org_memory").update({ lines: [] }).eq("org_id", orgId).select("org_id")).data ?? []).toEqual([]);
    // mcp_set_agent_task as Pelle (sees it, not the runner, not an admin): refused at the last line too.
    expect(must("pelle", await admin.rpc("mcp_set_agent_task", { p_user: pelle.id, p_meeting: allMeeting, p_item: "a1", p_status: "in_progress", p_note: null }))).toBe(false);
    expect(must("anna", await admin.rpc("mcp_set_agent_task", { p_user: anna.id, p_meeting: allMeeting, p_item: "a1", p_status: "in_progress", p_note: null }))).toBe(true);
  });
});
