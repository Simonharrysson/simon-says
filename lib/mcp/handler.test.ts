import type { User } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { connectAs, fakeReader, MCP_URL, ORIGIN, resultOf } from "@/test/mcp-kit";
import { handleMcp, RATE_PER_MINUTE, type McpDeps } from "./handler";
import { memoryStore } from "./store";
import type { ToolDeps } from "./tools";

// The MCP SDK client against handleMcp in-process (test/mcp-kit.ts): the full connector flow with
// a test user, no Google, no database (memory store and a fixed reader; tests/db/mcp.test.ts runs
// the real mcp_* functions).

const USER = { id: "22222222-2222-4222-8222-222222222222", email: "simon@example.com" } as User;

const ORG = "88888888-8888-4888-8888-888888888888";
const PERSON = "99999999-9999-4999-8999-999999999999";
const HANDOFF = "33333333-3333-4333-8333-333333333333";

function deps(over: Partial<McpDeps> = {}) {
  const m = memoryStore();
  const setHandoffDone = vi.fn(async (id: string) => id === HANDOFF);
  const d: McpDeps = {
    origin: ORIGIN,
    store: m.store,
    reader: (userId) =>
      fakeReader(userId, {
        orgs: async () => [{ id: ORG, name: "Bolaget", kind: "foretag", role: "member" }],
        people: async () => [{ id: PERSON, org_id: ORG, name: "Simon", role: null, member_user_id: USER.id }],
        handoffs: async () => [
          { id: HANDOFF, org_id: ORG, meeting_id: "secret-meeting", owner_person_id: PERSON, text: "Gör bilden", due: "fredag", due_date: "2026-12-04", from_name: "Jonas", status: "approved", done: false, created_at: "2026-11-20T10:00:00Z" },
        ],
        setHandoffDone,
      }),
    loadUser: async (id) => (id === USER.id ? USER : null),
    enabled: () => true,
    toolDeps: {} as ToolDeps,
    ...over,
  };
  return { d, m };
}

const post = (d: McpDeps, headers: Record<string, string> = {}) =>
  handleMcp(new Request(MCP_URL, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: "{}" }), d);

describe("handleMcp refusals", () => {
  it("401 with the RFC 9728 challenge without a token", async () => {
    const { d } = deps();
    const r = await post(d);
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`);
    expect((await post(d, { authorization: "Bearer ssa_" + "x".repeat(43) })).status).toBe(401);
  });
  it("403 for a foreign Origin", async () => {
    const { d } = deps();
    expect((await post(d, { origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("the SDK client through the whole connector flow", () => {
  it("discovers, registers, authorizes, lists and calls tools", async () => {
    const { d, m } = deps();
    const { client } = await connectAs(USER.id, d);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["complete_task", "get_meeting", "get_org_memory", "list_agent_tasks", "list_spaces", "my_tasks", "prepare_agenda", "search_meetings", "update_agent_task"]);

    const open = resultOf(await client.callTool({ name: "my_tasks", arguments: {} }));
    expect(open.isError).toBe(false);
    const tasks = (open.data as { tasks: Record<string, unknown>[] }).tasks;
    expect(tasks).toHaveLength(1);
    expect(JSON.stringify(open.data)).not.toContain("meeting_id");
    // A reviewed Företag task never names its meeting.
    expect(tasks[0]).toMatchObject({ task_id: "h:33333333-3333-4333-8333-333333333333", from: "Jonas" });
    expect(JSON.stringify(tasks[0])).not.toContain("secret-meeting");

    const done = resultOf(await client.callTool({ name: "complete_task", arguments: { task_id: "h:33333333-3333-4333-8333-333333333333" } }));
    expect(done.data).toMatchObject({ done: true });
    const bad = resultOf(await client.callTool({ name: "complete_task", arguments: { task_id: "nope" } }));
    expect(bad.isError).toBe(true);

    // Audit: one row per call, ids only.
    expect(m.audits.map((a) => [a.tool, a.ok])).toEqual([
      ["my_tasks", true],
      ["complete_task", true],
      ["complete_task", false],
    ]);
    expect(m.audits[1].ids).toEqual({ task_id: "h:33333333-3333-4333-8333-333333333333" });
    expect(JSON.stringify(m.audits)).not.toContain("Gör bilden");
    await client.close();
  });

  it("refuses when MCP is switched off (MCP_ENABLED=0), or the user is gone", async () => {
    const { d } = deps();
    const { provider } = await connectAs(USER.id, d);
    const auth = { authorization: `Bearer ${provider.saved!.access_token}` };
    expect((await post({ ...d, enabled: () => false }, auth)).status).toBe(503);
    expect((await post({ ...d, loadUser: async () => null }, auth)).status).toBe(401);
  });

  it("rate-limits per user", async () => {
    const { d } = deps();
    const { provider } = await connectAs(USER.id, d);
    const auth = { authorization: `Bearer ${provider.saved!.access_token}` };
    let last = 0;
    for (let i = 0; i < RATE_PER_MINUTE + 2; i++) last = (await post(d, auth)).status;
    expect(last).toBe(429);
  });
});
