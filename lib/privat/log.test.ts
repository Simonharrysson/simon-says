import { describe, expect, it } from "vitest";
import { decisionLog, firstSentence, recurring, type SummaryForLog } from "./log";

const s = (id: string, day: string, over: Partial<SummaryForLog> = {}): SummaryForLog => ({
  meeting_id: id,
  created_at: `2026-11-${day}T12:00:00Z`,
  started_at: `2026-11-${day}T10:00:00Z`,
  decisions: [],
  facts: [],
  people: [],
  topics: [],
  ...over,
});

describe("the context's log", () => {
  it("decisions and facts newest first, each once", () => {
    const log = decisionLog([
      s("a", "10", { decisions: ["Vi skriver i LaTeX"], facts: ["Tentan 14 jan"] }),
      s("b", "20", { decisions: ["Labb 2 på fredag", "vi skriver i latex"] }),
    ]);
    expect(log.map((e) => [e.kind, e.text, e.meetingId])).toEqual([
      ["decision", "Labb 2 på fredag", "b"],
      ["decision", "vi skriver i latex", "b"],
      ["fact", "Tentan 14 jan", "a"],
    ]);
  });

  it("recurring people and topics: in two recordings or more, most frequent first", () => {
    const all = [
      s("a", "10", { people: ["Anna", "Erik"], topics: ["labb 2", "tentan"] }),
      s("b", "15", { people: ["anna"], topics: ["Tentan"] }),
      s("c", "20", { people: ["Anna", "Lisa"], topics: ["tentan", "labb 2"] }),
    ];
    expect(recurring(all, "people")).toEqual([{ name: "Anna", count: 3 }]);
    expect(recurring(all, "topics")).toEqual([
      { name: "tentan", count: 3 },
      { name: "labb 2", count: 2 },
    ]);
    expect(recurring([s("a", "10", { people: ["Anna", "Anna"] })], "people")).toEqual([]);
  });

  it("first sentence for lists", () => {
    expect(firstSentence("Vi gick igenom labb 2. Sedan tentan.")).toBe("Vi gick igenom labb 2.");
    expect(firstSentence("Utan punkt")).toBe("Utan punkt");
    expect(firstSentence("x".repeat(300)).length).toBe(160);
  });
});
