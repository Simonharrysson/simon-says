import { afterEach, describe, expect, it, vi } from "vitest";
import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { applyOps, buildRequest, churn, nextItemId, updateNotes, usageCost, type NotesClient, type UpdateNotesInput } from "@/lib/notes/engine";
import { SYSTEM_PROMPT } from "@/lib/notes/prompt";
import type { NotesItem } from "@/lib/notes/schema";

const items: NotesItem[] = [
  { id: "n1", section: "decision", text: "Hackathon 14 mars i Kårhuset" },
  { id: "n2", section: "action", text: "Skicka sponsoravtalet", owner: "Erik Johansson", due: "fredag" },
  { id: "n4", section: "now", text: "Budget för maten" },
];
const locked: NotesItem[] = [{ id: "n3", section: "action", text: "Anna bokar lokalen (ändrat av Anna)" }];

function input(over: Partial<UpdateNotesInput> = {}): UpdateNotesInput {
  return {
    orgName: "Kodklubben",
    transcriptBlocks: ["[00:00] S1-speaker_0: Hej", "[00:45] S1-speaker_1: Budgeten är 5 000 kr"],
    speakerNames: { "S1-speaker_0": "Anna Lindqvist", "S1-speaker_1": "Erik Johansson" },
    notesTabText: "Beslut\n✓ Hackathon 14 mars i Kårhuset\nEgen rad av Maja",
    items,
    locked,
    deletedIds: ["n5"],
    final: false,
    ...over,
  };
}

function message(over: Partial<BetaMessage> & { text?: string } = {}): BetaMessage {
  const { text = '{"ops":[]}', ...rest } = over;
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 10_000,
      cache_creation_input_tokens: 2000,
    },
    ...rest,
  } as unknown as BetaMessage;
}

function fakeClient(msg: BetaMessage) {
  const stream = vi.fn((_body: BetaMessageStreamParams) => ({ finalMessage: async () => msg }));
  const client: NotesClient = { beta: { messages: { stream } } };
  return { client, stream };
}

const opsText = (ops: unknown[]) => JSON.stringify({ ops });

afterEach(() => vi.restoreAllMocks());

describe("updateNotes", () => {
  it("drops ops on locked and deleted ids, keeps valid ones", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = fakeClient(
      message({
        text: opsText([
          { op: "change", id: "n3", text: "omskrivet" }, // locked
          { op: "remove", id: "n3" }, // remove of a locked item
          { op: "change", id: "n5", text: "x" }, // deleted
          { op: "add", id: "n5", section: "decision", text: "återuppstånden" }, // deleted id reused
          { op: "add", id: "n6", section: "decision", text: "Matbudget max 5 000 kr" },
          { op: "change", id: "n2", due: "torsdag" },
        ]),
      }),
    );
    const out = await updateNotes(input(), { client });
    expect(out.ops).toEqual([
      { op: "add", item: { id: "n6", section: "decision", text: "Matbudget max 5 000 kr" } },
      { op: "change", id: "n2", due: "torsdag" },
    ]);
    expect(out.dropped).toBe(4);
    expect(out.items.map((i) => i.id)).toEqual(["n1", "n2", "n4", "n6"]);
    expect(out.items.find((i) => i.id === "n2")?.due).toBe("torsdag");
    expect(out.items.some((i) => i.id === "n3")).toBe(false); // locked items are not ours
  });

  it("ignores a remove of a locked item even when the caller also lists it in items", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = fakeClient(message({ text: opsText([{ op: "remove", id: "n3" }]) }));
    const out = await updateNotes(input({ items: [...items, locked[0]] }), { client });
    expect(out.ops).toEqual([]);
    expect(out.dropped).toBe(1);
  });

  it("refusal → no ops, content not read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = fakeClient(
      message({ stop_reason: "refusal", text: opsText([{ op: "remove", id: "n1" }]) }),
    );
    const out = await updateNotes(input(), { client });
    expect(out.ops).toEqual([]);
    expect(out.items).toEqual(items);
    expect(out.stopReason).toBe("refusal");
    expect(warn).toHaveBeenCalledWith("notes engine: refusal", null);
    expect(out.usage.output).toBe(500);
  });

  it("max_tokens → no ops", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeClient(message({ stop_reason: "max_tokens", text: '{"ops":[{"op":"remove","id":"n1"}' }));
    const out = await updateNotes(input(), { client });
    expect(out.ops).toEqual([]);
  });

  it.each([
    ["not JSON", "Sure! Here are the ops"],
    ["wrong shape", '{"operations":[]}'],
    ["bad op kind", '{"ops":[{"op":"rename","id":"n1"}]}'],
  ])("malformed output (%s) → no ops + log", async (_name, text) => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeClient(message({ text }));
    const out = await updateNotes(input(), { client });
    expect(out.ops).toEqual([]);
    expect(out.items).toEqual(items);
    expect(err).toHaveBeenCalledWith("notes engine: malformed output", expect.any(String));
    // never logs the content
    expect(JSON.stringify(err.mock.calls)).not.toContain(text);
  });

  it("request: model, effort medium, structured output, fallbacks default, breakpoint on the newest transcript block", async () => {
    const { client, stream } = fakeClient(message());
    await updateNotes(input(), { client });
    const body = stream.mock.calls[0][0];
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.output_config?.effort).toBe("medium");
    expect(body.output_config?.format?.type).toBe("json_schema");
    expect(body).not.toHaveProperty("output_format");
    expect(body).not.toHaveProperty("thinking"); // adaptive is the default; never disabled/budget
    expect(body.fallbacks).toBe("default");
    expect(body.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(body.system).toBe(SYSTEM_PROMPT);
    expect(body.messages).toHaveLength(1); // no assistant prefill
    const content = body.messages[0].content as { type: string; text: string; cache_control?: unknown }[];
    expect(content).toHaveLength(3);
    expect(content[0].cache_control).toBeUndefined();
    expect(content[1]).toMatchObject({ text: "[00:45] S1-speaker_1: Budgeten är 5 000 kr", cache_control: { type: "ephemeral" } });
    expect(content[2].cache_control).toBeUndefined();
    const tail = content[2].text;
    expect(tail).toContain("S1-speaker_1 = Erik Johansson");
    expect(tail).toContain("Egen rad av Maja");
    expect(tail).toContain('"id":"n3"');
    expect(tail).toContain("<deleted_ids>n5</deleted_ids>");
    expect(tail).toContain("Next new id: n6");
  });

  it("the cached prefix of tick N is unchanged in tick N+1 (append-only)", () => {
    const a = buildRequest(input());
    const b = buildRequest(input({ transcriptBlocks: [...input().transcriptBlocks, "[01:30] S1-speaker_0: Nästa punkt"], final: true }));
    const strip = (blocks: unknown[]) => blocks.map((x) => ({ ...(x as object), cache_control: undefined }));
    const ca = a.messages[0].content as unknown[];
    const cb = b.messages[0].content as unknown[];
    expect(strip(cb.slice(0, 2))).toEqual(strip(ca.slice(0, 2)));
    expect(b.system).toBe(a.system);
    expect(b.output_config).toEqual(a.output_config);
  });

  it("usage.usd at $4 in / $20 out / $0.20 cache read / $5 cache write per MTok", async () => {
    const { client } = fakeClient(message());
    const out = await updateNotes(input(), { client });
    // 1000*4 + 500*20 + 10000*0.2 + 2000*5 = 4000 + 10000 + 2000 + 10000 = 26000 → $0.026
    expect(out.usage).toEqual({ input: 1000, output: 500, cacheRead: 10_000, cacheWrite: 2000, usd: 0.026 });
    expect(usageCost({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(4);
  });

  it("final pass is flagged in the instruction", () => {
    const body = buildRequest(input({ final: true }));
    const content = body.messages[0].content as { text: string }[];
    expect(content.at(-1)!.text).toContain("FINAL pass");
  });

  it("no transcript yet: no breakpoint, only the tail", () => {
    const body = buildRequest(input({ transcriptBlocks: [] }));
    const content = body.messages[0].content as { cache_control?: unknown }[];
    expect(content).toHaveLength(1);
    expect(content[0].cache_control).toBeUndefined();
  });
});

describe("applyOps", () => {
  it("a second 'now' item becomes a change of the existing one", () => {
    const out = applyOps(items, [{ op: "add", item: { id: "n6", section: "now", text: "Affischen" } }], []);
    expect(out.ops).toEqual([{ op: "change", id: "n4", text: "Affischen" }]);
    expect(out.items.filter((i) => i.section === "now")).toEqual([{ id: "n4", section: "now", text: "Affischen" }]);
  });

  it("rejects reused ids, bad id formats, unknown targets and no-op changes; '' clears owner", () => {
    const out = applyOps(
      items,
      [
        { op: "add", item: { id: "n1", section: "decision", text: "dubblett" } },
        { op: "add", item: { id: "x9", section: "decision", text: "fel id" } },
        { op: "change", id: "n99", text: "finns inte" },
        { op: "change", id: "n1", text: "Hackathon 14 mars i Kårhuset" },
        { op: "change", id: "n2", owner: "" },
      ],
      [],
    );
    expect(out.ops).toEqual([{ op: "change", id: "n2", owner: "" }]);
    expect(out.dropped).toBe(4);
    expect(out.items.find((i) => i.id === "n2")).toEqual({ id: "n2", section: "action", text: "Skicka sponsoravtalet", due: "fredag" });
  });

  it("never touches a protected (locked/deleted) id, even one present in items", () => {
    const out = applyOps(
      items,
      [
        { op: "change", id: "n1", text: "omskrivet" },
        { op: "remove", id: "n2" },
        { op: "add", item: { id: "n9", section: "decision", text: "ny" } },
      ],
      ["n1", "n2", "n9"],
    );
    expect(out.ops).toEqual([]);
    expect(out.items).toEqual(items);
    expect(out.dropped).toBe(3);
  });

  it("does not mutate its input", () => {
    const copy = structuredClone(items);
    applyOps(items, [{ op: "change", id: "n1", text: "ny" }, { op: "remove", id: "n2" }], []);
    expect(items).toEqual(copy);
  });
});

describe("churn", () => {
  it("fixed pair: 1 of 3 eligible items changed, 'now' and locked excluded", () => {
    const prev: NotesItem[] = [
      { id: "n1", section: "decision", text: "A" },
      { id: "n2", section: "action", text: "B", owner: "Erik" },
      { id: "n3", section: "decision", text: "C" },
      { id: "n4", section: "now", text: "topic 1" },
      { id: "n5", section: "decision", text: "locked" },
    ];
    const next: NotesItem[] = [
      { id: "n1", section: "decision", text: "A" },
      { id: "n2", section: "action", text: "B", owner: "Maja" }, // changed
      { id: "n3", section: "decision", text: "C" },
      { id: "n4", section: "now", text: "topic 2" }, // 'now' not counted
      { id: "n6", section: "decision", text: "new" }, // additions not counted
    ];
    expect(churn(prev, next, ["n5"])).toBeCloseTo(1 / 3);
    expect(churn(prev, next.slice(1), ["n5"])).toBeCloseTo(2 / 3); // removal counts
    expect(churn([], next, [])).toBe(0);
  });
});

describe("nextItemId", () => {
  it("counts past every used id", () => {
    expect(nextItemId(["n1", "n12", "n3", "header"])).toBe("n13");
    expect(nextItemId([])).toBe("n1");
  });
});
