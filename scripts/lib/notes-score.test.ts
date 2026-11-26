import { describe, expect, it } from "vitest";
import type { NotesItem } from "@/lib/notes/schema";
import { checkExpected, matches, score, scorePasses, type Expected } from "./notes-score";

const item = (id: string, section: NotesItem["section"], text: string, owner?: string): NotesItem => ({ id, section, text, ...(owner ? { owner } : {}) });

describe("matches", () => {
  it("matches whole words by default", () => {
    expect(matches("Kick-off on the 22nd", [["2nd"]])).toBe(false);
    expect(matches("Kick-off on the 2nd", [["2nd"]])).toBe(true);
    expect(matches("Avgiften höjs 15 %", [["5 %"]])).toBe(false);
    expect(matches("Avgiften höjs 5 %.", [["5 %"]])).toBe(true);
    expect(matches("Buy cardboard boxes", [["card"]])).toBe(false);
  });
  it("a * drops the boundary on its side (stems, Swedish compounds)", () => {
    expect(matches("Årsavgiften höjs", [["avgift"]])).toBe(false);
    expect(matches("Årsavgiften höjs", [["*avgift*"]])).toBe(true);
    expect(matches("Skicka fakturorna", [["faktur*"]])).toBe(true);
  });
  it("ignores case and thousands separators; every group must hit", () => {
    expect(matches("Högst 40 000 kr", [["40000"], ["kr"]])).toBe(true);
    expect(matches("Högst 40 000 kr", [["40000"], ["euro"]])).toBe(false);
  });
});

describe("score", () => {
  const expected: Expected = {
    speakerNames: { a: "Tom Reeves", b: "Priya Shah" },
    decisions: [{ key: "D1", text: "Open day 15 March", match: [["15"], ["march"]] }],
    action_items: [{ key: "A1", owner: "Priya Shah", text: "Email sponsors", match: [["sponsor*"]] }],
    must_not: [
      { key: "M1", text: "old owner", sections: ["action"], match: [["sponsor*"]], owner: "Tom Reeves" },
      { key: "M2", text: "reversed", sections: ["decision"], match: [["mower*"]], unless: [["reversed", "next meeting"]], fromMs: 100_000 },
    ],
  };
  const final = [item("n1", "decision", "Open day 15 March"), item("n2", "action", "Email sponsors", "Priya Shah")];

  it("finds expected items with the right owner", () => {
    const s = score(final, expected);
    expect([s.found, s.total, s.mustNot.length]).toEqual([2, 2, 0]);
  });
  it("owner switch: the old owner's name in the text also counts", () => {
    const s = score([...final, item("n3", "action", "Tom emails the sponsors")], expected);
    expect(s.mustNot.map((l) => l.split(" ")[0])).toEqual(["M1"]);
  });
  it("live: 2+ ticks in a row fail, a single tick is a warning; ticks before fromMs are ignored", () => {
    const mower = item("n4", "decision", "Buy the mower");
    const ticks = [
      { atMs: 45_000, items: [mower] },
      { atMs: 90_000, items: [mower] },
      { atMs: 135_000, items: [mower] },
      { atMs: 180_000, items: [{ ...mower, text: "Mower purchase reversed" }] },
    ];
    expect(score(final, expected, ticks).mustNotPersistent).toEqual([]);
    expect(score(final, expected, ticks).mustNotLive.length).toBe(1);
    const lingering = [...ticks.slice(0, 3), { atMs: 180_000, items: [mower] }];
    expect(score(final, expected, lingering).mustNotPersistent.length).toBe(1);
  });
  it("checkExpected flags a must_not that matches an expected item", () => {
    expect(checkExpected(expected)).toEqual([]);
    expect(checkExpected({ ...expected, must_not: [{ key: "X", text: "", sections: ["action"], match: [["sponsor*"]] }] })).toEqual(["X matches expected A1"]);
  });
});

describe("agenda mode", () => {
  const people = [
    { name: "Anna Berg", role: "Kassör" },
    { name: "Bo Ek", role: "Ordförande" },
  ];
  const agenda: NonNullable<Expected["agenda"]> = {
    profile: "veckomote",
    items: [
      { key: "ag-1", label: "Må-runda", role: "checkin" },
      { key: "ag-2", label: "Från förra veckan", role: "followup" },
      { key: "ag-3", label: "Event", role: "topic" },
      { key: "ag-4", label: "Ekonomi", role: "topic" },
    ],
  };
  const points = Array.from({ length: 10 }, (_, k) => ({ key: `D${k}`, text: `Punkt${k}x`, anchor: "ag-3", match: [[`punkt${k}x`]] }));
  const expected: Expected = {
    speakerNames: { a: "Anna Berg", b: "Bo Ek" },
    agenda,
    people,
    decisions: points,
    action_items: [{ key: "A1", owner: "Anna Berg", ownerLabel: "Kassör", anchor: "ag-4", text: "Betala hyran", match: [["hyra*"]] }],
    carried: [
      { id: "c1", owner: "Bo Ek", text: "Boka banan", done: true },
      { id: "c2", owner: "Anna Berg", text: "Betala februarihyran", done: true },
    ],
    checkin: { match: [["tandläkar*", "vinterdäck*"]] },
  };
  const carried = (done2: boolean): NotesItem[] => [
    { id: "c1", section: "action", text: "Boka banan", owner: "Bo Ek", carried: true, anchor: "ag-2", done: true },
    { id: "c2", section: "action", text: "Betala februarihyran", owner: "Anna Berg", carried: true, anchor: "ag-2", ...(done2 ? { done: true } : {}) },
  ];
  const decisions = (wrong: number): NotesItem[] =>
    points.map((p, k) => ({ id: `n${k + 1}`, section: "decision", text: `Punkt${k}x`, anchor: k < wrong ? "ag-4" : "ag-3" }));
  const hyra: NotesItem = { id: "n20", section: "action", text: "Betala hyran", owner: "Anna Berg", anchor: "ag-4" };
  const final = (wrong: number, done2 = true) => [...carried(done2), ...decisions(wrong), hyra];

  it("placement: 9 of 10 under the expected item passes, 8 of 10 fails", () => {
    const nine = score(final(1), expected);
    expect(nine.placement).toEqual({ ok: 10, total: 11 });
    const ten = decisions(1).map((d) => (d.id === "n1" ? { ...d, anchor: "ag-3" } : d));
    expect(score([...carried(true), ...ten, hyra], expected).placement).toEqual({ ok: 11, total: 11 });
    // exactly 9 of 10 anchored points: the action sits right, 1 of 10 decisions wrong -> 10/11 >= 0.9
    const wrongNine = score(final(1), { ...expected, action_items: [] });
    expect(wrongNine.placement).toEqual({ ok: 9, total: 10 });
    expect(scorePasses(wrongNine)).toBe(true);
    const wrongTwo = score(final(2), { ...expected, action_items: [] });
    expect(wrongTwo.placement).toEqual({ ok: 8, total: 10 });
    expect(scorePasses(wrongTwo)).toBe(false);
  });
  it("roles: the owner's role equals ownerLabel", () => {
    expect(score(final(0), expected).roles).toEqual({ ok: 1, total: 1 });
    const wrong = { ...expected, action_items: [{ ...expected.action_items![0], ownerLabel: "Ordförande" }] };
    expect(score(final(0), wrong).roles).toEqual({ ok: 0, total: 1 });
    expect(scorePasses(score(final(0), wrong))).toBe(false);
  });
  it("followup: a carried task expected done but not fails", () => {
    expect(score(final(0, true), expected).followup).toEqual({ ok: 2, total: 2 });
    const s = score(final(0, false), expected);
    expect(s.followup).toEqual({ ok: 1, total: 2 });
    expect(scorePasses(s)).toBe(false);
  });
  it("checkinLeaks with Må-runda hiding on (opt-in): a Må-runda line in the notes, final or live, or an item under checkin/followup", () => {
    const on = { hideCheckin: true };
    expect(score(final(0), expected, [], on).checkinLeaks).toEqual([]);
    expect(scorePasses(score(final(0), expected, [], on))).toBe(true);
    const leak = item("n30", "action", "Jag ska boka tandläkaren", "Bo Ek");
    const s = score([...final(0), leak], expected, [], on);
    expect(s.checkinLeaks.length).toBe(1);
    expect(scorePasses(s)).toBe(false);
    const live = score(final(0), expected, [{ atMs: 45_000, items: [leak] }], on);
    expect(live.checkinLeaks.length).toBe(1);
    const underCheckin = score([...final(0), { id: "n31", section: "note", text: "Alla mår bra.", anchor: "ag-1" }], expected, [], on);
    expect(underCheckin.checkinLeaks.length).toBe(1);
    const underFollowup = score([...final(0), { id: "n32", section: "note", text: "Hyran.", anchor: "ag-2" }], expected, [], on);
    expect(underFollowup.checkinLeaks.length).toBe(1);
  });
  it("checkinLeaks by default (hiding off): Må-runda content and items under it are ordinary notes; under followup still leaks", () => {
    const leak = item("n30", "action", "Jag ska boka tandläkaren", "Bo Ek");
    expect(score([...final(0), leak], expected).checkinLeaks).toEqual([]);
    expect(score(final(0), expected, [{ atMs: 45_000, items: [leak] }]).checkinLeaks).toEqual([]);
    expect(score([...final(0), { id: "n31", section: "note", text: "Alla mår bra.", anchor: "ag-1" }], expected).checkinLeaks).toEqual([]);
    expect(score([...final(0), { id: "n32", section: "note", text: "Hyran.", anchor: "ag-2" }], expected).checkinLeaks.length).toBe(1);
  });
  it("v1 expected files: the new bars are empty and pass", () => {
    const s = score([item("n1", "decision", "Open day 15 March")], { decisions: [{ key: "D", text: "Open day 15 March", match: [["15"]] }] });
    expect([s.placement, s.roles, s.followup, s.checkinLeaks]).toEqual([{ ok: 0, total: 0 }, { ok: 0, total: 0 }, { ok: 0, total: 0 }, []]);
    expect(scorePasses(s)).toBe(true);
  });
  it("checkExpected: an anchor missing from agenda.items, a bad ownerLabel, an unknown carried id", () => {
    expect(checkExpected(expected)).toEqual([]);
    const bad: Expected = {
      ...expected,
      decisions: [{ ...points[0], anchor: "ag-9" }],
      action_items: [{ ...expected.action_items![0], ownerLabel: "Ordförande" }],
      carried: [{ id: "x1", owner: "Anna Berg", text: "t", done: false }],
    };
    const problems = checkExpected(bad).join("\n");
    expect(problems).toMatch(/D0: anchor ag-9 is not in agenda\.items/);
    expect(problems).toMatch(/A1: ownerLabel/);
    expect(problems).toMatch(/carried x1/);
    const checkinAnchor: Expected = { ...expected, decisions: [{ ...points[0], anchor: "ag-1" }] };
    expect(checkExpected(checkinAnchor).join("\n")).toMatch(/D0: anchor ag-1 is a checkin item/);
  });
});
