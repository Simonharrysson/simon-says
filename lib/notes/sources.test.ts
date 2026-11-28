import { describe, expect, it } from "vitest";
import { formatItem, toNotesItem } from "@/lib/docs/notes";
import type { NoteItemRow } from "@/lib/db/types";
import { applyOps } from "@/lib/notes/engine";
import type { NotesItem } from "@/lib/notes/schema";
import { toAgendaOp, toNotesOp } from "@/lib/notes/schema";
import {
  addToIndex,
  formatSaidAt,
  MAX_SOURCES,
  normalizeRef,
  parseSegmentKey,
  resolveSources,
  saidAtSuffix,
  segmentKey,
  stripSaidAt,
  type SourceIndex,
} from "@/lib/notes/sources";

const at = (h: number, m: number, s: number) => ((h * 60 + m) * 60 + s) * 1000;
const index = (): SourceIndex =>
  addToIndex(new Map(), [
    { key: "el-a:4:0", startMs: at(0, 41, 52) + 300 },
    { key: "el-a:5:0", startMs: at(0, 42, 10) },
    { key: "el-b:2:0", startMs: at(0, 42, 10) + 800 }, // a second session, same second
    { key: "el-a:9:1", startMs: at(1, 5, 9) },
  ]);

describe("formatSaidAt (mm:ss)", () => {
  it("reads mm:ss under an hour, h:mm:ss from one hour on", () => {
    expect(formatSaidAt(0)).toBe("00:00");
    expect(formatSaidAt(at(0, 4, 5))).toBe("04:05");
    expect(formatSaidAt(at(0, 41, 52) + 999)).toBe("41:52");
    expect(formatSaidAt(at(0, 59, 59))).toBe("59:59");
    expect(formatSaidAt(at(1, 0, 0))).toBe("1:00:00");
    expect(formatSaidAt(at(2, 5, 9))).toBe("2:05:09");
    expect(formatSaidAt(-5)).toBe("00:00");
  });

  it("the Doc suffix and stripping it back off", () => {
    expect(saidAtSuffix(at(0, 41, 52))).toBe(" (41:52)");
    expect(saidAtSuffix(null)).toBe("");
    expect(saidAtSuffix(undefined)).toBe("");
    expect(stripSaidAt("✓ Vi kör på fredag (41:52)", at(0, 41, 52))).toBe("✓ Vi kör på fredag");
    // A person's own parenthesis, or another time, is theirs.
    expect(stripSaidAt("✓ Vi kör (12:00)", at(0, 41, 52))).toBe("✓ Vi kör (12:00)");
    expect(stripSaidAt("✓ Vi kör", null)).toBe("✓ Vi kör");
  });
});

describe("segment ids", () => {
  it("key round trip", () => {
    const key = segmentKey({ el_session_id: "el-x:y", segment_index: 12, run_index: 0 });
    expect(key).toBe("el-x:y:12:0");
    expect(parseSegmentKey(key)).toEqual({ elSessionId: "el-x:y", segmentIndex: 12, runIndex: 0 });
    expect(parseSegmentKey("nope")).toBeNull();
    expect(parseSegmentKey(":1:2")).toBeNull();
  });

  it("normalizes the ways Claude may write a bracket time", () => {
    expect(normalizeRef("00:41:52")).toBe("00:41:52");
    expect(normalizeRef("[00:41:52]")).toBe("00:41:52");
    expect(normalizeRef("0:41:52")).toBe("00:41:52");
    expect(normalizeRef("41:52")).toBe("00:41:52");
    expect(normalizeRef("1:05:09")).toBe("01:05:09");
    for (const bad of ["", "41", "00:61:00", "00:41:72", "n3", "S1-speaker_0", "00:41:52:01"]) expect(normalizeRef(bad)).toBeNull();
  });

  it("resolves only times of lines that were sent; drops the rest; never a wrong link", () => {
    expect(resolveSources(["00:41:52"], index())).toEqual({ ids: ["el-a:4:0"], saidAtMs: at(0, 41, 52) + 300 });
    // Both segments of that second, earliest first; the earliest is where the link points.
    expect(resolveSources(["00:42:10", "00:41:52"], index())).toEqual({
      ids: ["el-a:4:0", "el-a:5:0", "el-b:2:0"],
      saidAtMs: at(0, 41, 52) + 300,
    });
    expect(resolveSources(["00:13:00", "garbage"], index())).toBeNull();
    expect(resolveSources(["00:13:00", "01:05:09"], index())).toEqual({ ids: ["el-a:9:1"], saidAtMs: at(1, 5, 9) });
    expect(resolveSources([], index())).toBeNull();
    expect(resolveSources(undefined, index())).toBeNull();
    expect(resolveSources(["00:41:52"], undefined)).toBeNull();
    expect(resolveSources(["00:41:52"], new Map())).toBeNull();
  });

  it("caps the sources and dedupes repeated times", () => {
    const many = addToIndex(
      new Map(),
      Array.from({ length: 10 }, (_, i) => ({ key: `el:${i}:0`, startMs: at(0, 10, i) })),
    );
    const r = resolveSources(["00:10:05", "00:10:05", "00:10:01", "00:10:09", "00:10:00", "00:10:03"], many)!;
    expect(r.ids.length).toBe(MAX_SOURCES);
    expect(r.ids).toEqual(["el:0:0", "el:1:0", "el:3:0"]);
  });
});

describe("applyOps: sources (0069)", () => {
  const decision: NotesItem = { id: "n1", section: "decision", text: "Vi kör på fredag" };
  const sourced: NotesItem = { id: "n2", section: "action", text: "Boka lokal", owner: "Anna", sources: ["el-a:5:0"], saidAtMs: at(0, 42, 10) };

  it("an add gets the resolved moment; a forged one on the item is ignored", () => {
    const op = toNotesOp({ op: "add", id: "n9", section: "decision", text: "Budgeten antas", src: ["00:41:52"] })!;
    const forged = { ...op, item: { ...(op as { item: NotesItem }).item, sources: ["other-meeting:1:0"], saidAtMs: 1 } } as typeof op;
    const r = applyOps([], [forged], { sources: index() });
    expect(r.items[0]).toMatchObject({ id: "n1", sources: ["el-a:4:0"], saidAtMs: at(0, 41, 52) + 300 });
    // Without an index (or with an unknown time) no moment at all.
    const none = applyOps([], [forged], {});
    expect(none.items[0].sources).toBeUndefined();
    expect(none.items[0].saidAtMs).toBeUndefined();
    const unknown = applyOps([], [toNotesOp({ op: "add", id: "n9", section: "decision", text: "X", src: ["00:00:01"] })!], { sources: index() });
    expect(unknown.items[0].sources).toBeUndefined();
  });

  it("never on attendees or the now line", () => {
    const r = applyOps(
      [],
      [
        toNotesOp({ op: "add", id: "n9", section: "now", text: "Budget", src: ["00:41:52"] })!,
        toNotesOp({ op: "add", id: "n10", section: "attendees", text: "Anna", src: ["00:41:52"] })!,
      ],
      { sources: index() },
    );
    expect(r.items.every((i) => i.sources === undefined)).toBe(true);
  });

  it("a change fills a missing moment once, and moves it only with a changed text", () => {
    const fill = applyOps([decision], [toNotesOp({ op: "change", id: "n1", src: ["00:41:52"] })!], { sources: index() });
    expect(fill.ops.length).toBe(1);
    expect(fill.items[0]).toMatchObject({ sources: ["el-a:4:0"] });
    const keep = applyOps([sourced], [toNotesOp({ op: "change", id: "n2", src: ["00:41:52"] })!], { sources: index() });
    expect(keep.items[0].sources).toEqual(["el-a:5:0"]);
    // A citation alone that changes nothing is a quiet no-op, not a rejection (no "all_dropped").
    expect(keep.dropped).toBe(0);
    expect(keep.ignored).toBe(1);
    const moved = applyOps([sourced], [toNotesOp({ op: "change", id: "n2", text: "Boka stora lokalen", src: ["01:05:09"] })!], { sources: index() });
    expect(moved.items[0]).toMatchObject({ text: "Boka stora lokalen", sources: ["el-a:9:1"], saidAtMs: at(1, 5, 9) });
  });

  it("a carried task never takes a moment (it was said in another meeting)", () => {
    const carried: NotesItem = { id: "c1", section: "action", text: "Boka bussen", carried: true, anchor: "ag-1" };
    const r = applyOps([carried], [toAgendaOp({ op: "change", id: "c1", done: true, src: ["00:41:52"] })!], { sources: index() });
    expect(r.items[0]).toMatchObject({ done: true });
    expect(r.items[0].sources).toBeUndefined();
  });

  it("agenda ops carry src too", () => {
    const op = toAgendaOp({ op: "add", id: "n9", kind: "task", anchor: "notes", text: "Ring kommunen", src: [" 00:42:10 ", ""] });
    expect(op).toMatchObject({ op: "add", src: ["00:42:10"] });
    expect(toAgendaOp({ op: "change", id: "n1", src: ["00:42:10"] })).toMatchObject({ op: "change", id: "n1", src: ["00:42:10"] });
    expect(toNotesOp({ op: "change", id: "n1", src: [] })).toBeNull();
  });
});

describe("Doc line and row (0069)", () => {
  const row = (over: Partial<NoteItemRow> = {}): NoteItemRow => ({
    meeting_id: "m1",
    id: "n1",
    section: "decision",
    text: "Vi kör på fredag",
    owner: null,
    due: null,
    locked: false,
    deleted_by_human: false,
    last_rendered_text: null,
    range_name: null,
    position: 0,
    ...over,
  });

  it("the moment is appended to decisions and tasks; old rows render as before", () => {
    expect(formatItem(toNotesItem(row({ source_segment_ids: ["el-a:4:0"], said_at_ms: at(0, 41, 52) })))).toBe("✓ Vi kör på fredag (41:52)");
    expect(formatItem(toNotesItem(row()))).toBe("✓ Vi kör på fredag");
    expect(formatItem({ section: "action", text: "Boka lokal", owner: "Anna", due: "fredag", saidAtMs: at(1, 2, 3) })).toBe("☐ Anna: Boka lokal (fredag) (1:02:03)");
  });

  it("a carried row has no moment, even when its source had one", () => {
    const item = toNotesItem(row({ carried_from_id: "n4", source_segment_ids: ["el-a:4:0"], said_at_ms: 5000 }));
    expect(item.sources).toBeUndefined();
    expect(item.saidAtMs).toBeUndefined();
  });
});
