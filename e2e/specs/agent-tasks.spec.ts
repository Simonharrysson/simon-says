import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { APP_URL, FAKE_URL } from "../env";
import { ensureUser, expect, expectAccessible, fake, seedMeeting, test } from "../fixtures";

// "Claude, gör det här" (0065): a meeting gave a task to Claude → its runner sees it in Mina
// uppgifter as "Hos Claude" → Claude (over the real /api/mcp, with a token seeded the way the OAuth
// flow stores one) lists it as a brief and reports progress → the note shows on the meeting page →
// done → "✓ klart" in the Doc.

const must = <T>(what: string, r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

/** Our rendered line in the meeting's Doc: the text plus its named range, as a tick leaves it. */
async function renderLine(docId: string, meetingId: string, itemId: string, text: string) {
  const res = await fetch(`${FAKE_URL}/v1/documents/${docId}:batchUpdate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requests: [
        { insertText: { text, location: { index: 1, tabId: "t.0" } } },
        { createNamedRange: { name: `ss-${meetingId}-${itemId}`, range: { tabId: "t.0", startIndex: 1, endIndex: 1 + text.length } } },
      ],
    }),
  });
  if (!res.ok) throw new Error(`fake batchUpdate: ${res.status} ${await res.text()}`);
}

/** A connected Claude for `userId`: a client, a grant and an access token, stored as the OAuth flow stores them (hash only). */
async function seedToken(db: SupabaseClient, userId: string): Promise<string> {
  const clientId = `ssk_${randomBytes(12).toString("base64url")}`;
  must("client", await db.from("mcp_clients").insert({ id: clientId, client_name: "Claude (e2e)", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }));
  const grant = must("grant", await db.from("mcp_grants").insert({ user_id: userId, client_id: clientId, client_name: "Claude (e2e)", resource: `${APP_URL}/api/mcp` }).select("id").single()) as { id: string };
  const token = `ssa_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(token, "utf8").digest("hex");
  must("token", await db.from("mcp_tokens").insert({ token_hash: hash, grant_id: grant.id, kind: "access", expires_at: new Date(Date.now() + 3_600_000).toISOString() }));
  return token;
}

/** One tools/call over Streamable HTTP (the server is stateless: JSON in, JSON out). */
async function callTool(token: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: unknown; text: string }> {
  const res = await fetch(`${APP_URL}/api/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  if (!res.ok) throw new Error(`mcp ${name}: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { result?: { content: { text: string }[]; isError?: boolean }; error?: { message: string } };
  if (!body.result) throw new Error(`mcp ${name}: ${body.error?.message}`);
  const text = body.result.content.map((c) => c.text).join("");
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* a refusal is plain text */
  }
  return { isError: Boolean(body.result.isError), data, text };
}

test("Claude, gör det här: Hos Claude in Mina uppgifter → progress over MCP on the meeting page → done → ✓ klart in the Doc @phone", async ({ db, seedOrg, signedIn, newEmail }) => {
  test.setTimeout(120_000);
  // The runner is a plain member: as the assigner they see and may move the task Claude got.
  const email = newEmail("claude-uppdrag");
  const me = await ensureUser(db, email);
  const org = await seedOrg({ members: [email] });
  const meeting = await seedMeeting(db, org, { startedBy: email, daysAgo: 1 });
  const line = "Claude: Sammanställ offerterna.";
  await renderLine(meeting.docId, meeting.id, "n1", line);
  must(
    "rows",
    await db.from("note_items").insert([
      { meeting_id: meeting.id, id: "n1", section: "action", kind: "task", text: "Sammanställ offerterna", owner: "Claude", done_when: "En tabell i Driven", position: 0, range_name: `ss-${meeting.id}-n1`, last_rendered_text: line },
      { meeting_id: meeting.id, id: "d1", section: "decision", kind: "decision", text: "Vi väljer leverantör i december", position: 1 },
    ]),
  );
  const taskId = `n:${meeting.id}:n1`;

  const { page } = await signedIn(email, "/hem");
  const list = page.getByRole("list", { name: "Mina uppgifter" });
  await expect(list).toContainText("Sammanställ offerterna");
  await expect(list).toContainText("Hos Claude · Väntar");
  await expectAccessible(page);

  // Claude: the brief, then progress.
  const token = await seedToken(db, me);
  const listed = await callTool(token, "list_agent_tasks", {});
  expect(listed.data).toMatchObject({
    tasks: [{ task_id: taskId, task: "Sammanställ offerterna", done_when: "En tabell i Driven", can_update: true, context: { decisions: ["Vi väljer leverantör i december"] }, meeting: { meeting_id: meeting.id } }],
  });
  expect((await callTool(token, "update_agent_task", { task_id: taskId, status: "in_progress", note: "Har läst tre av fem offerter" })).data).toMatchObject({ status: "in_progress" });

  await page.goto(`${org.url}/mote/${meeting.id}`);
  const tasks = page.getByRole("list", { name: "Uppgifter" });
  await expect(tasks).toContainText("Hos Claude · Pågår");
  await expect(tasks).toContainText("Claude: Har läst tre av fem offerter");
  await expectAccessible(page);

  // Done: the same path as ticking it, so the Doc gets ✓ klart.
  expect((await callTool(token, "update_agent_task", { task_id: taskId, status: "done", note: "Tabellen ligger i Driven" })).data).toMatchObject({ status: "done", doc: "written" });
  await expect.poll(() => fake.docText(meeting.docId), { message: "✓ klart in the Doc" }).toContain(`${line} ✓ klart`);
  await page.reload();
  await expect(page.getByRole("list", { name: "Uppgifter" })).toContainText("Hos Claude · Klar");
  await expect(page.getByRole("list", { name: "Uppgifter" })).toContainText("Claude: Tabellen ligger i Driven");
  // Once done, Claude can't move it again.
  expect((await callTool(token, "update_agent_task", { task_id: taskId, status: "in_progress" })).isError).toBe(true);
});
