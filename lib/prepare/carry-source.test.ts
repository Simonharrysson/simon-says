import { describe, expect, it } from "vitest";
import { carriedForMeeting } from "@/lib/agenda/followup";
import { VECKOMOTE } from "@/lib/formats/standard";
import { followupSource, importedCarried, preparedSkipsMeetings } from "./carry-source";
import { buildDraft, droppedSources, refreshDraft } from "./draft";

const people = [{ id: "p1", name: "Anna Berg", role: "Kassör" }];
const ctx = { profile: VECKOMOTE, ownerLabel: (o: string) => (o === "Anna Berg" ? "Kassör" : o) };
const PID = "0b9e6a52-3f1c-4d7e-9a51-2f6c8d4e1a01";

describe("followupSource", () => {
  const prev = { id: "m1", date: "2026-11-10" };
  it("no earlier real meeting and no protocol: none (Testmöten never count)", () => {
    expect(followupSource({ prev: null, protocol: null, preparedDate: "2026-12-02" })).toEqual({ use: null, id: null, origin: { kind: "none" } });
  });
  it("the real meeting when it is the newest", () => {
    expect(followupSource({ prev, protocol: { id: PID, date: "2026-11-03" }, preparedDate: "2026-12-02" })).toMatchObject({ use: "meeting", id: "m1", origin: { kind: "meeting", date: "2026-11-10" } });
  });
  it("the real meeting on the same day as the protocol", () => {
    expect(followupSource({ prev, protocol: { id: PID, date: "2026-11-10" }, preparedDate: "2026-12-02" }).use).toBe("meeting");
  });
  it("an imported protocol newer than the last real meeting", () => {
    expect(followupSource({ prev, protocol: { id: PID, date: "2026-11-19" }, preparedDate: "2026-12-02" })).toEqual({ use: "import", id: PID, origin: { kind: "import", date: "2026-11-19" } });
    expect(followupSource({ prev: null, protocol: { id: PID, date: "2026-11-19" }, preparedDate: "2026-12-02" }).use).toBe("import");
  });
  it("within 60 days; older is too old, and the older real meeting is not used either", () => {
    expect(followupSource({ prev: null, protocol: { id: PID, date: "2026-10-03" }, preparedDate: "2026-12-02" }).use).toBe("import");
    expect(followupSource({ prev: { id: "m0", date: "2026-08-01" }, protocol: { id: PID, date: "2026-10-02" }, preparedDate: "2026-12-02" })).toEqual({
      use: null,
      id: null,
      origin: { kind: "too_old", date: "2026-10-02" },
    });
  });
});

describe("importedCarried", () => {
  const items = [
    { position: 0, kind: "topic", text: "Rekrytering", owner: null, done: null },
    { position: 3, kind: "task", text: "Beställa nya bollar", owner: "Anna Berg", done: null },
    { position: 5, kind: "task", text: "Boka banan", owner: "Ordförande", done: false },
    { position: 6, kind: "task", text: "Skicka fakturan", owner: "Kassör", done: true },
  ];
  const rows = importedCarried(PID, items, "followup", people);

  it("carries open tasks only (done false or unknown), owners as role labels", () => {
    expect(rows.map((r) => [r.text, r.owner])).toEqual([
      ["Beställa nya bollar", "Anna Berg"],
      ["Boka banan", "Ordförande"],
    ]);
    const draft = buildDraft({ profile: VECKOMOTE, carried: rows, ctx, topics: [], origin: { kind: "import", date: "2026-11-19" } });
    const f = draft.find((i) => i.role === "followup")!;
    expect(f.tasks!.map((t) => t.line)).toEqual(["Kassör: Beställa nya bollar.", "Ordförande: Boka banan."]);
    expect(f.origin).toEqual({ kind: "import", date: "2026-11-19" });
  });

  it("source keys point at the protocol, never at a note_items row, and match the save's filter", () => {
    expect(rows.map((r) => [r.carried_from_meeting, r.carried_from_id])).toEqual([
      [PID, "h3"],
      [PID, "h5"],
    ]);
    const draft = buildDraft({ profile: VECKOMOTE, carried: rows, ctx, topics: [] });
    const f = draft.find((i) => i.role === "followup")!;
    // Unticking an imported task drops it: droppedSources uses the same key the save filters by.
    const unticked = draft.map((i) => (i === f ? { ...i, tasks: f.tasks!.map((t, n) => ({ ...t, on: n !== 0 })) } : i));
    const dropped = new Set(droppedSources(unticked));
    const desired = rows.filter((r) => !dropped.has(`${r.carried_from_meeting}:${r.carried_from_id}`));
    expect(desired.map((r) => r.text)).toEqual(["Boka banan"]);
  });

  it("the start takes the prepared imported lines over as they stand (no older meeting added)", () => {
    const prepared = rows.map((r, i) => ({ ...r, meeting_id: "prep", range_name: `ss-prep-c${i + 1}` }));
    const out = carriedForMeeting({
      meetingId: "new",
      prev: null,
      sameDoc: { id: "prep-x", rows: prepared },
      intact: () => true,
      followup: "followup",
      people,
      groupBy: "role",
    });
    expect(out.map((r) => [r.text, r.carried_from_meeting, r.carried_from_id, r.range_name])).toEqual([
      ["Beställa nya bollar", PID, "h3", "ss-prep-c1"],
      ["Boka banan", PID, "h5", "ss-prep-c2"],
    ]);
  });
});

describe("preparedSkipsMeetings", () => {
  const item = (origin?: unknown) => ({ items: [{ id: "std:followup", label: "Från förra veckan", role: "followup" as const, source: "standing" as const, on: true, ...(origin ? { origin } : {}) }] });
  it("an agenda drawn from a protocol (or with it too old) carries no older meeting at the start", () => {
    expect(preparedSkipsMeetings(item({ kind: "import", date: "2026-11-19" }) as never)).toBe(true);
    expect(preparedSkipsMeetings(item({ kind: "too_old", date: "2026-08-19" }) as never)).toBe(true);
  });
  it("a meeting-drawn, empty or older agenda keeps today's start", () => {
    expect(preparedSkipsMeetings(item({ kind: "meeting", date: "2026-11-24" }) as never)).toBe(false);
    expect(preparedSkipsMeetings(item({ kind: "none" }) as never)).toBe(false);
    expect(preparedSkipsMeetings(item() as never)).toBe(false);
  });
});

describe("refreshDraft", () => {
  it("preparing again shows the current source (origin), not the stored one", () => {
    const stored = buildDraft({ profile: VECKOMOTE, carried: [], ctx, topics: [], origin: { kind: "none" } });
    const fresh = buildDraft({ profile: VECKOMOTE, carried: importedCarried(PID, [{ position: 1, kind: "task", text: "Boka banan", owner: null, done: null }], "followup", people), ctx, topics: [], origin: { kind: "import", date: "2026-11-19" } });
    const out = refreshDraft(stored, fresh, new Set());
    const f = out.find((i) => i.role === "followup")!;
    expect(f.origin).toEqual({ kind: "import", date: "2026-11-19" });
    expect(f.tasks).toHaveLength(1);
  });
});
