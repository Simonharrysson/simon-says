import { describe, expect, it } from "vitest";
import { carriedItems } from "@/lib/agenda/followup";
import type { NoteItemRow } from "@/lib/db/types";
import { ARSMOTE, STYRELSEPROTOKOLL, VECKOMOTE } from "@/lib/formats/standard";
import { buildDraft, droppedSources, kindsOfType, normaliseItems, refreshDraft, validDate, type DraftItem } from "./draft";
import { isMeetingType, isOfferedType, MEETING_TYPES, meetingTypeName } from "./types";

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

describe("Mål att ta upp (todo #12)", () => {
  const goals = [
    { goalId: "g1", title: "Fler medlemmar till vårens event", kind: "quiet" as const, reason: "Inget nytt sedan 12 okt" },
    { goalId: "g2", title: "Ny lokal", kind: "decision" as const, reason: "Följ upp beslutet från förra veckan" },
  ];

  it("goals come unticked as 'Mål: <titel>' topics with their reason, after the topics and before Övrigt", () => {
    const items = buildDraft({ profile: VECKOMOTE, carried: [], ctx, topics: [{ label: "Sponsring", meetings: 3 }], goals });
    expect(items.map((i) => [i.id, i.label, i.role, i.on, i.reason ?? null]).slice(-4)).toEqual([
      ["topic:sponsring", "Sponsring", "topic", false, null],
      ["goal:fler medlemmar till vårens event", "Mål: Fler medlemmar till vårens event", "topic", false, "Inget nytt sedan 12 okt"],
      ["goal:ny lokal", "Mål: Ny lokal", "topic", false, "Följ upp beslutet från förra veckan"],
      ["std:other", "Övrigt", "other", true, null],
    ]);
  });

  it("ticked: on the agenda as a topic, label only (the reason never reaches the stored draft or the Doc)", () => {
    const fresh = buildDraft({ profile: VECKOMOTE, carried: [], ctx, topics: [], goals });
    const body = fresh.map((i) => ({ id: i.id, label: i.label, source: i.source, on: i.id === "goal:ny lokal" ? true : i.on }));
    const saved = normaliseItems(body, fresh)!;
    const goal = saved.find((i) => i.id === "goal:ny lokal")!;
    expect(goal).toEqual({ id: "goal:ny lokal", label: "Mål: Ny lokal", role: "topic", source: "suggested", on: true });
    // Preparing again: today's reason comes from the fresh draft; a goal no longer suggested has none.
    const again = refreshDraft(saved, buildDraft({ profile: VECKOMOTE, carried: [], ctx, topics: [], goals: [goals[0]] }), new Set());
    expect(again.find((i) => i.id === "goal:ny lokal")!.reason).toBeUndefined();
    expect(again.find((i) => i.id === "goal:fler medlemmar till vårens event")!.reason).toBe("Inget nytt sedan 12 okt");
    // An unticked goal no longer suggested (e.g. the admin removed it) is not offered again.
    const none = refreshDraft(saved, buildDraft({ profile: VECKOMOTE, carried: [], ctx, topics: [], goals: [] }), new Set());
    expect(none.some((i) => i.id === "goal:fler medlemmar till vårens event")).toBe(false);
    expect(none.find((i) => i.id === "goal:ny lokal")!.on).toBe(true);
  });
});

describe("meeting types (todo #15)", () => {
  it("Veckomöte and Årsmöte are offered; a stored Styrelsemöte still has its name", () => {
    expect(MEETING_TYPES.map((t) => t.type)).toEqual(["veckomote", "arsmote"]);
    expect(isOfferedType("styrelsemote")).toBe(false);
    expect(isMeetingType("styrelsemote")).toBe(true);
    expect(isMeetingType("nope")).toBe(false);
    expect(meetingTypeName("styrelsemote")).toBe("Styrelsemöte");
    expect(meetingTypeName("arsmote")).toBe("Årsmöte");
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
