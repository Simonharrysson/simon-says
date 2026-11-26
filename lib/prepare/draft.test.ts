import { describe, expect, it } from "vitest";
import { carriedItems } from "@/lib/agenda/followup";
import type { NoteItemRow } from "@/lib/db/types";
import { ARSMOTE, STYRELSEPROTOKOLL, VECKOMOTE } from "@/lib/formats/standard";
import { buildDraft, droppedSources, kindsOfType, normaliseItems, refreshDraft, validDate, type DraftItem } from "./draft";

const task = (id: string, text: string, owner: string | null, due: string | null = null): NoteItemRow =>
  ({ meeting_id: "m1", id, section: "action", kind: "task", text, owner, due, done: false, locked: false, deleted_by_human: false, position: 0 }) as NoteItemRow;

const people = [{ id: "p1", name: "Anna Berg", role: "Kassör" }];
const ctx = { profile: VECKOMOTE, ownerLabel: (o: string) => (o.startsWith("Anna") ? "Kassör" : o) };

describe("buildDraft", () => {
  it("Veckomöte: standing items, Från förra veckan with the open tasks, recurring topics unticked before Övrigt", () => {
    const carried = carriedItems("m1", [task("n1", "Boka Kårallen", "Anna Berg", "fredag"), task("n2", "Skicka kallelsen", "Erik")], "followup", people);
    const items = buildDraft({
      profile: VECKOMOTE,
      carried,
      ctx,
      topics: [
        { label: "Sponsring", meetings: 3 },
        { label: "från förra veckan", meetings: 4 },
      ],
    });
    expect(items.map((i) => [i.label, i.source, i.on])).toEqual([
      ["Godkänn dagordning", "standing", true],
      ["Må-runda", "standing", true],
      ["Från förra veckan", "standing", true],
      ["Sponsring", "suggested", false],
      ["Övrigt", "standing", true],
    ]);
    expect(items[2].tasks).toEqual([
      { source: "m1:n2", line: "Erik: Skicka kallelsen.", on: true },
      { source: "m1:n1", line: "Kassör: Boka Kårallen (fredag).", on: true },
    ]);
    expect(items.at(-1)?.last).toBe(true);
  });

  it("Styrelsemöte and Årsmöte have no Från förra veckan; kinds per type", () => {
    expect(buildDraft({ profile: STYRELSEPROTOKOLL, carried: [], ctx, topics: [] }).some((i) => i.tasks)).toBe(false);
    const ars = buildDraft({ profile: ARSMOTE, carried: [], ctx, topics: [] });
    expect(ars.map((i) => i.label).slice(-2)).toEqual(["Övriga frågor", "Mötets avslutande"]);
    expect(kindsOfType("veckomote")).toContain(null);
    expect(kindsOfType("arsmote")).toEqual(["arsmote"]);
  });
});

describe("normaliseItems, droppedSources, refreshDraft", () => {
  const server = buildDraft({ profile: VECKOMOTE, carried: carriedItems("m1", [task("n1", "Boka Kårallen", "Anna Berg")], "followup", people), ctx, topics: [] });

  it("roles and task lines come from the server; order, labels and ticks from the client", () => {
    const out = normaliseItems(
      [
        { id: "add:1", label: "Fest på universitetet", source: "added", on: true },
        { id: "std:followup", label: "Från förra veckan", source: "standing", on: true, tasks: [{ source: "m1:n1", on: false }] },
        { id: "std:nope", label: "Hackad", source: "standing", on: true },
        { id: "std:other", label: "Övrigt", source: "standing", on: true },
      ],
      server,
    )!;
    expect(out.map((i) => [i.id, i.role])).toEqual([
      ["add:1", "topic"],
      ["std:followup", "followup"],
      ["std:other", "other"],
    ]);
    expect(out[1].tasks).toEqual([{ source: "m1:n1", line: "Kassör: Boka Kårallen.", on: false }]);
    expect(droppedSources(out)).toEqual(["m1:n1"]);
  });

  it("nothing on → null; a stored draft gets the current tasks, the dropped ones unticked", () => {
    expect(normaliseItems([{ id: "std:other", label: "Övrigt", source: "standing", on: false }], server)).toBeNull();
    const stored: DraftItem[] = [{ ...server[2], tasks: [] }];
    expect(refreshDraft(stored, server, new Set(["m1:n1"]))[0].tasks).toEqual([{ source: "m1:n1", line: "Kassör: Boka Kårallen.", on: false }]);
  });

  it("validDate", () => {
    expect(validDate("2026-12-03")).toBe(true);
    expect(validDate("2026-02-30")).toBe(false);
  });
});
