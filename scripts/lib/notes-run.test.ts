import { join } from "node:path";
import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describe, expect, it } from "vitest";
import { CHECKIN_SYSTEM_PROMPT } from "@/lib/notes/checkin";
import type { NotesClient } from "@/lib/notes/engine";
import { agendaTabText, loadExpected, loadLines, runReplay } from "./notes-run";

// Agenda-mode replay with a fake client (no API): the detector and notes calls are told apart by
// their system prompt; what each call received is recorded.

const dir = join("fixtures", "notes");
const lines = loadLines(join(dir, "veckomote-b.jsonl"));
const expected = loadExpected(join(dir, "veckomote-b.expected.json"));

const message = (text: string): BetaMessage =>
  ({
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    model: "claude-opus-5-5",
    usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }) as unknown as BetaMessage;

function fake(detector: (newTimes: string[], call: number) => string | "fail") {
  const notes: string[][] = [];
  let detectorCalls = 0;
  const client: NotesClient = {
    beta: {
      messages: {
        stream: (body: BetaMessageStreamParams) => ({
          finalMessage: async () => {
            const content = (body.messages[0].content as { text: string }[]).map((b) => b.text);
            if (body.system === CHECKIN_SYSTEM_PROMPT) {
              const times = [...content[0].matchAll(/<new_lines>([\s\S]*?)<\/new_lines>/g)][0][1].match(/\[(\d\d:\d\d:\d\d)\]/g)!.map((t) => t.slice(1, -1));
              const answer = detector(times, detectorCalls++);
              return message(answer === "fail" ? "nonsense" : answer);
            }
            notes.push(content);
            return message('{"ops":[]}');
          },
        }),
      },
    },
  };
  return { client, notes, detectorCalls: () => detectorCalls };
}

describe("agenda replay", () => {
  it("masks the window the detector found and counts the detector's cost", async () => {
    const f = fake((times, call) => (call === 0 ? JSON.stringify({ start_at: times[0], end_at: null }) : JSON.stringify({ start_at: null, end_at: times.at(-1) })));
    const r = await runReplay({ lines, expected, tickMs: 45_000, agenda: true, client: f.client });
    expect(r.log.some((t) => (t.checkinUsd ?? 0) > 0)).toBe(true);
    expect(r.totalUsd).toBeCloseTo(r.log.reduce((s, t) => s + t.usage.usd + (t.checkinUsd ?? 0), 0));
    const last = f.notes.at(-1)!.join("\n");
    expect(last).toContain("[Må-runda — utelämnad]");
    // The first tick's detector call opened the window at the tick's first line.
    expect(r.log[0].window?.startMs).toBe(lines[0].startMs);
    // The carried tasks are in the items from the start, and in the tab as our own lines.
    expect(r.items.filter((i) => i.carried).map((i) => i.id)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  it("holds the notes call while the start is unknown and the detector fails, then closes after 3 failures", async () => {
    const f = fake(() => "fail");
    const r = await runReplay({ lines, expected, tickMs: 45_000, agenda: true, client: f.client });
    expect(r.log.slice(0, 2).map((t) => t.skipped)).toEqual(["held", "held"]);
    expect(r.log[2].window?.closed).toBe(true);
    // Held ticks made no notes call; the first call came at tick 3 with the three ticks' blocks.
    expect(f.notes[0].length).toBe(3 + 1);
    expect(r.log[0].usage.usd).toBe(0);
  });

  it("makes no call on a tick without new lines", async () => {
    const sparse = [lines[0], { ...lines[1], startMs: 200_000 }];
    const f = fake(() => JSON.stringify({ start_at: null, end_at: null }));
    const r = await runReplay({ lines: sparse, expected, tickMs: 45_000, agenda: true, client: f.client });
    expect(r.log.filter((t) => t.skipped === "idle").length).toBeGreaterThan(0);
  });
});

describe("agendaTabText", () => {
  it("lists the agenda lines, then our items as the renderer writes them (owner as role)", () => {
    const { text, ownLines } = agendaTabText(expected, [
      { id: "n1", section: "action", text: "Boka banan", owner: "Fatima Rahimi", due: "fredag", anchor: "ag-4" },
      { id: "n2", section: "decision", text: "Köp bollar", anchor: "ag-5" },
    ]);
    expect(ownLines).toEqual(["Eventansvarig: Boka banan (fredag).", "Beslut: Köp bollar."]);
    expect(text.split("\n").slice(0, 3)).toEqual(["Godkänn dagordning", "Må-runda", "Från förra veckan"]);
    expect(text).toContain("Prova-på-kväll för nybörjare");
  });
});

describe("styrelse-ekdala (C2): the replay runs as a Styrelseprotokoll", () => {
  const styrelse = loadExpected(join(dir, "styrelse-ekdala.expected.json"));
  const styrelseLines = loadLines(join(dir, "styrelse-ekdala.jsonl"));

  it("the tail carries the §-numbered decision note; no Må-runda detector without a checkin item", async () => {
    const f = fake(() => "fail");
    const r = await runReplay({ lines: styrelseLines, expected: styrelse, tickMs: 45_000, agenda: true, client: f.client });
    expect(f.detectorCalls()).toBe(0);
    expect(r.log.every((t) => t.window === null)).toBe(true);
    const tail = f.notes[0].at(-1)!;
    expect(tail).toContain("Format: Styrelseprotokoll");
    expect(tail).toContain("§-numbered board minutes");
    // No followup item in Styrelseprotokoll (R-C1): nothing carried.
    expect(r.items.filter((i) => i.carried)).toEqual([]);
    expect(tail).toContain("Föregående protokoll · other");
  });

  it("decisions render once as 'Beslut: <sentence>'", () => {
    const { ownLines } = agendaTabText(styrelse, [{ id: "n1", section: "decision", text: "Att anta den reviderade budgeten för 2027", anchor: "ag-8" }]);
    expect(ownLines).toEqual(["Beslut: Att anta den reviderade budgeten för 2027."]);
  });
});
