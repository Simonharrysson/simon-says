import type { SupabaseClient, User } from "@supabase/supabase-js";
import { fakeReader } from "@/test/mcp-kit";
import { describe, expect, it, vi } from "vitest";
import { likePattern, page, parseTaskId, prepareAgenda, snippet, type ToolCtx, type ToolDeps } from "./tools";

const ORG = "55555555-5555-4555-8555-555555555555";
const M = "66666666-6666-4666-8666-666666666666";

const item = (id: string, label: string, on = true) => ({ id, label, role: "topic" as const, source: "standing" as const, on });

function ctx(kind: "forening" | "foretag" | "privat" | null, opts: { prepared?: boolean } = {}) {
  const savePrepared = vi.fn(async (_db: unknown, _u: unknown, _o: unknown, body: { date: string }) => ({ ok: true as const, docUrl: "https://docs.google.com/document/d/x/edit", docName: "Dagordning", date: body.date, created: !opts.prepared, reordered: true }));
  const loadDraft = vi.fn(async (_db: unknown, _org: string, type: string, date: string) => ({
    ok: true as const,
    draft: { type: type as "veckomote", date, time: "18:00", formatName: "Veckomöte", items: [item("open", "Mötets öppnande"), item("budget", "Budget")], existing: null },
  }));
  const deps = {
    upcomingPrepared: vi.fn(async () => (opts.prepared === false ? [] : [{ id: "prep1", meeting_date: "2026-12-03", meeting_time: "18:00", kind: "veckomote", doc_id: "x", doc_name: "Dagordning" }])),
    loadDraft,
    savePrepared,
    completeNoteTask: vi.fn(),
    actorClient: () => ({}) as SupabaseClient,
  } as unknown as ToolDeps;
  const c: ToolCtx = {
    reader: fakeReader("u1", {
      orgs: async () => (kind ? [{ id: ORG, name: "Föreningen", kind, role: "member" as const }] : []),
      // The last meeting: a Thursday 18:10 (Stockholm), so the proposal is Thursday 3 Dec 18:00.
      meetings: async (q) => (q.ids && q.ids[0] !== M ? [] : [{ id: M, org_id: ORG, started_at: "2026-11-26T17:10:00Z", status: "done" }]),
    }),
    user: { id: "u1", email: "a@b.se" } as User,
    deps,
    now: new Date("2026-11-27T10:00:00Z"),
    ids: {},
  };
  return { c, savePrepared, loadDraft };
}

describe("prepare_agenda", () => {
  it("adds the point to the next prepared agenda through savePrepared", async () => {
    const { c, savePrepared } = ctx("forening");
    const r = await prepareAgenda(c, { org_id: ORG, point: "  Julfesten " });
    expect(r).toMatchObject({ ok: true, data: { added: true, date: "2026-12-03" } });
    const body = (savePrepared.mock.calls[0] as unknown[])[3] as { date: string; time: string; items: { label: string; on: boolean; source: string }[] };
    expect(body.date).toBe("2026-12-03");
    expect(body.time).toBe("18:00");
    expect(body.items.map((i) => i.label)).toEqual(["Mötets öppnande", "Budget", "Julfesten"]);
    expect(body.items[2]).toMatchObject({ on: true, source: "added" });
    expect(c.ids).toEqual({ org_id: ORG, prepared_id: "prep1" });
  });
  it("creates the next meeting's agenda when none is prepared (Förbered möte's proposal)", async () => {
    const { c, savePrepared, loadDraft } = ctx("forening", { prepared: false });
    expect(await prepareAgenda(c, { org_id: ORG, point: "Julfesten" })).toMatchObject({ ok: true, data: { added: true, created: true, date: "2026-12-03" } });
    expect(loadDraft.mock.calls[0].slice(1, 4)).toEqual([ORG, "veckomote", "2026-12-03"]);
    const body = (savePrepared.mock.calls[0] as unknown[])[3] as { items: { label: string }[] };
    expect(body.items.at(-1)?.label).toBe("Julfesten");
  });
  it("resolves meeting_id to its förening", async () => {
    const { c } = ctx("forening");
    expect(await prepareAgenda(c, { meeting_id: M, point: "Ny punkt" })).toMatchObject({ ok: true });
    expect(c.ids.meeting_id).toBe(M);
  });
  it("never writes for a duplicate, a missing agenda, a Företag or Privat, or an unknown org", async () => {
    for (const [kind, args, opts] of [
      ["forening", { org_id: ORG, point: "budget" }, {}],
      ["foretag", { org_id: ORG, point: "X" }, {}],
      ["privat", { org_id: ORG, point: "X" }, {}],
      [null, { org_id: ORG, point: "X" }, {}],
      ["forening", { point: "X" }, {}],
      ["forening", { org_id: ORG, point: "x".repeat(121) }, {}],
    ] as const) {
      const { c, savePrepared } = ctx(kind, opts);
      await prepareAgenda(c, args);
      expect(savePrepared).not.toHaveBeenCalled();
    }
  });
});

describe("helpers", () => {
  it("parses task ids", () => {
    expect(parseTaskId(`n:${M}:n12-t`)).toEqual({ kind: "note", meetingId: M, itemId: "n12-t" });
    expect(parseTaskId(`p:${M}`)).toEqual({ kind: "privat", id: M });
    expect(parseTaskId(`h:${M}`)).toEqual({ kind: "handoff", id: M });
    expect(parseTaskId(`n:${M}:a,b`)).toBeNull();
    expect(parseTaskId("p:not-a-uuid")).toBeNull();
    expect(parseTaskId(`x:${M}`)).toBeNull();
  });
  it("pages with an offset cursor and a capped limit", () => {
    const all = Array.from({ length: 30 }, (_, i) => i);
    expect(page(all, undefined, undefined)).toEqual({ items: all.slice(0, 10), next_cursor: "10" });
    expect(page(all, "25", 10)).toEqual({ items: all.slice(25), next_cursor: null });
    expect(page(all, undefined, 100).items).toHaveLength(25);
    expect(page(all, "garbage", 5).items[0]).toBe(0);
  });
  it("cuts a snippet around the match and escapes ilike", () => {
    const text = `${"a ".repeat(100)}budgeten antas ${"b ".repeat(100)}`;
    const s = snippet(text, "budgeten");
    expect(s.length).toBeLessThanOrEqual(162);
    expect(s).toContain("budgeten antas");
    expect(snippet("kort", "x")).toBe("kort");
    expect(likePattern("100%_a\\b")).toBe("%100\\%\\_a\\\\b%");
  });
});
