import { describe, expect, it } from "vitest";
import type { docs_v1 } from "@googleapis/docs";
import { allSeries } from "@/scripts/lib/goals-fixtures";
import { datesIn, docTabs, headingDate, splitProtocols } from "./doc-text";

// A picked Doc is not assumed to be one meeting (todo #7 review): running Docs, one tab per
// meeting, transcript tabs. Fictional protocol series from the goals eval.

const series = allSeries();
const para = (t: string) => ({ paragraph: { elements: [{ textRun: { content: `${t}\n` } }] } });
const tab = (title: string, text: string, id = title) => ({
  tabProperties: { tabId: id, title },
  documentTab: { body: { content: text.split("\n").map(para) } },
});

describe("dates and headings", () => {
  it("reads the date formats the protocols use", () => {
    expect(datesIn("Datum: 2025-09-02")).toEqual(["2025-09-02"]);
    expect(datesIn("Styrelsemöte 3 september 2025")).toEqual(["2025-09-03"]);
    expect(datesIn("Ridån styrelsemöte 18/2-26")).toEqual(["2026-02-18"]);
    expect(datesIn("möte 4.11.2025")).toEqual(["2025-11-04"]);
    expect(datesIn("2025-02-30 och 14 februari")).toEqual([]);
    expect(datesIn("Board meeting 4 Sep 2025, then 12 October 2025 and 1 May 2026")).toEqual(["2025-09-04", "2025-10-12", "2026-05-01"]);
  });

  it("a heading is short and starts like a protocol; body lines and 'nästa möte' are not", () => {
    expect(headingDate("Protokoll styrelsemöte 2025-09-02")).toBe("2025-09-02");
    expect(headingDate("Datum: 2025-09-02")).toBe("2025-09-02");
    expect(headingDate("2025-09-02")).toBe("2025-09-02");
    expect(headingDate("Nästa möte: 2025-10-01")).toBeNull();
    expect(headingDate("Board meeting 4 Sep 2025")).toBe("2025-09-04");
    expect(headingDate("Next meeting 18 Sep 2025")).toBeNull();
    expect(headingDate("Datum för nästa möte 2025-10-01")).toBeNull();
    expect(headingDate("Vi bokade aulan till 2026-02-14 och skickar ut inbjudan till alla medlemmar i föreningen.")).toBeNull();
  });
});

describe("splitProtocols", () => {
  it("every single fixture protocol stays one section, dated right", () => {
    for (const s of series) {
      for (const p of s.protocols) {
        const r = splitProtocols(p.title, [{ title: "", text: p.text }]);
        expect(r.ok && r.sections.length, `${s.slug}#${p.index}`).toBe(1);
        expect(r.ok && r.sections[0].date).toBe(p.date);
      }
    }
  });

  it("a running Doc (a whole series in one tab, every house style) splits into one section per meeting", () => {
    for (const s of series) {
      const text = s.protocols.map((p) => p.text).join("\n\n");
      const r = splitProtocols("Protokoll 2025–2026", [{ title: "", text }]);
      expect(r.ok, s.slug).toBe(true);
      if (!r.ok) continue;
      expect(r.sections.map((x) => x.date)).toEqual(s.protocols.map((p) => p.date));
      // Each section is exactly that meeting's text (its title line included).
      r.sections.forEach((x, k) => expect(x.text).toBe(s.protocols[k].text.trim()));
    }
  });

  it("one tab per meeting; an undated appendix tab joins the meeting before it; transcript tabs are never read", () => {
    const [a, b] = series[2].protocols;
    const doc = {
      title: "Ridån protokoll",
      tabs: [tab("10/9-25", a.text), tab("Bilaga", "Budgetförslag för hösten"), tab("Transkript", "Elin: hej allihop"), tab("24/9-25", b.text, "t.x")],
    } as unknown as docs_v1.Schema$Document;
    const tabs = docTabs(doc);
    expect(tabs.map((t) => t.title)).toEqual(["10/9-25", "Bilaga", "24/9-25"]);
    expect(docTabs(doc, new Set(["t.x"])).map((t) => t.title)).toEqual(["10/9-25", "Bilaga"]);
    const r = splitProtocols("Ridån protokoll", tabs);
    expect(r.ok && r.sections.map((s) => s.date)).toEqual([a.date, b.date]);
    expect(r.ok && r.sections[0].text).toContain("Budgetförslag");
    expect(JSON.stringify(r)).not.toContain("hej allihop");
  });

  it("many dates with no reliable split → refused, never collapsed", () => {
    // Meetings headed only "Möte 5, tisdag" (no date on the heading line), dates in the body.
    const text = Array.from({ length: 12 }, (_, k) => `Möte ${k + 1}, tisdag\nVi träffades ${k + 1} mars 2026 i lokalen och gick igenom ekonomin, spelkvällarna och värvningen. ${"Diskussion om läget. ".repeat(40)}`).join("\n\n");
    expect(splitProtocols("Möten", [{ title: "", text }])).toEqual({ ok: false, reason: "many-meetings" });
    expect(splitProtocols("Tomt", [{ title: "", text: "  " }])).toEqual({ ok: false, reason: "empty" });
  });
});
