import { describe, expect, it } from "vitest";
import type { NotesItem } from "@/lib/notes/schema";
import { checkExpected, matches, score, type Expected } from "./notes-score";

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
