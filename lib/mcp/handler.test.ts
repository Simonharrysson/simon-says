import type { User } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { connectAs, MCP_URL, ORIGIN, resultOf } from "@/test/mcp-kit";
import { handleMcp, RATE_PER_MINUTE, type McpDeps } from "./handler";
import { memoryStore } from "./store";
import type { ToolDeps } from "./tools";

// The MCP SDK client against handleMcp in-process (test/mcp-kit.ts): the full connector flow with
// a test user, no Google, no database (memory store; the tools' loaders are mocked here; the DB
// test tests/db/mcp.test.ts runs them for real under RLS).

const USER = { id: "22222222-2222-4222-8222-222222222222", email: "simon@example.com" } as User;

function deps(over: Partial<McpDeps> = {}, tools: Partial<ToolDeps> = {}) {
  const m = memoryStore();
  const d: McpDeps = {
    origin: ORIGIN,
    supabaseUrl: "http://127.0.0.1:1",
    anonKey: "anon",
    jwtSecret: "secret",
    store: m.store,
    loadUser: async (id) => (id === USER.id ? USER : null),
    allowed: () => true,
    toolDeps: {
      loadHome: vi.fn(async () => ({
        spaces: [],
        recent: [],
        brandNew: false,
        unlinked: [],
        docs: {},
        approvals: [],
        tasks: [
          { key: "h:33333333-3333-4333-8333-333333333333", kind: "handoff", spaceId: "o", spaceName: "Bolaget", spaceKind: "foretag", meetingId: "secret-meeting", itemId: "x", text: "Gör bilden", due: "fredag", dueDate: "2026-12-04", doneWhen: null, contextName: null, done: false, meetingAt: "2026-11-20T10:00:00Z", position: 0, fromName: "Jonas" },
          { key: "p:44444444-4444-4444-8444-444444444444", kind: "privat", spaceId: "p", spaceName: "Privat", spaceKind: "privat", meetingId: "m", itemId: "y", text: "Läs kapitel 3", due: null, dueDate: null, doneWhen: null, contextName: "TDDE15", done: true, meetingAt: "2026-11-21T10:00:00Z", position: 0 },
        ],
      })) as unknown as ToolDeps["loadHome"],
      setHandoffDone: vi.fn(async () => true),
      ...tools,
    } as ToolDeps,
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
  it("403 for a foreign Origin, 503 without the JWT secret", async () => {
    const { d } = deps();
    expect((await post(d, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ ...d, jwtSecret: undefined })).status).toBe(503);
  });
});

describe("the SDK client through the whole connector flow", () => {
  it("discovers, registers, authorizes, lists and calls tools", async () => {
    const { d, m } = deps();
    const { client } = await connectAs(USER.id, d);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["complete_task", "get_meeting", "list_orgs", "my_tasks", "prepare_agenda", "search_meetings"]);

    const open = resultOf(await client.callTool({ name: "my_tasks", arguments: {} }));
    expect(open.isError).toBe(false);
    const tasks = (open.data as { tasks: Record<string, unknown>[] }).tasks;
    expect(tasks).toHaveLength(1);
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

  it("refuses when the allow-list no longer has the user, or the user is gone", async () => {
    const { d } = deps();
    const { provider } = await connectAs(USER.id, d);
    const auth = { authorization: `Bearer ${provider.saved!.access_token}` };
    expect((await post({ ...d, allowed: () => false }, auth)).status).toBe(403);
    expect((await post({ ...d, loadUser: async () => null }, auth)).status).toBe(401);
  });

  it("rate-limits per grant", async () => {
    const { d } = deps();
    const { provider } = await connectAs(USER.id, d);
    const auth = { authorization: `Bearer ${provider.saved!.access_token}` };
    let last = 0;
    for (let i = 0; i < RATE_PER_MINUTE + 2; i++) last = (await post(d, auth)).status;
    expect(last).toBe(429);
  });
});
