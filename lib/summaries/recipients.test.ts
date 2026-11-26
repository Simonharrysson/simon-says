import { describe, expect, it } from "vitest";
import { peopleNamed, presentPeople, summaryOptions, summaryRecipients, type SummaryPerson } from "./recipients";

const P = (id: string, name: string, over: Partial<SummaryPerson> = {}): SummaryPerson => ({
  id,
  name,
  email: `${id}@example.com`,
  member_user_id: null,
  ...over,
});

const anna = P("p-anna", "Anna Berg", { member_user_id: "u-anna", email: null });
const erik = P("p-erik", "Erik Lund");
const sara = P("p-sara", "Sara Holm");
const nils = P("p-nils", "Nils Ek", { email: null });
const people = [anna, erik, sara, nils];
const members = [{ userId: "u-anna", email: "anna@konto.se", role: "admin" as const }];

describe("peopleNamed", () => {
  it("matches the full name, else every person with that first name; ignores a trailing '?'", () => {
    expect(peopleNamed("anna berg", people)).toEqual(["p-anna"]);
    expect(peopleNamed("Erik?", people)).toEqual(["p-erik"]);
    const twins = [...people, P("p-erik2", "Erik Sund")];
    expect(peopleNamed("Erik", twins)).toEqual(["p-erik", "p-erik2"]);
    expect(peopleNamed("  ", people)).toEqual([]);
    expect(peopleNamed("Okänd", people)).toEqual([]);
  });
});

describe("presentPeople", () => {
  it("named voices (through merges), Närvarande names and the starter's account count as present", () => {
    const present = presentPeople({
      people,
      speakers: [
        { el_session_id: "s1", speaker_label: "speaker_0", person_id: null, display_name: "Talare 1", merged_into_label: "speaker_1" },
        { el_session_id: "s1", speaker_label: "speaker_1", person_id: "p-erik", display_name: "Erik" },
        { el_session_id: "s1", speaker_label: "speaker_2", person_id: null, display_name: "speaker_2" },
      ],
      attendeeNames: ["Sara"],
      startedBy: "u-anna",
    });
    expect([...present].sort()).toEqual(["p-anna", "p-erik", "p-sara"]);
  });

  it("a named voice without a person id is matched by its name", () => {
    const present = presentPeople({
      people,
      speakers: [{ el_session_id: "s1", speaker_label: "speaker_0", person_id: null, display_name: "Nils" }],
      attendeeNames: [],
      startedBy: null,
    });
    expect([...present]).toEqual(["p-nils"]);
  });
});

describe("summaryRecipients", () => {
  const present = new Set(["p-anna", "p-erik"]);

  it("missed (default): only people with an address who were not there; account address first", () => {
    const r = summaryRecipients({ mode: "missed", people, members, present });
    expect(r.map((x) => [x.person.id, x.email, x.missed])).toEqual([["p-sara", "p-sara@example.com", true]]);
  });

  it("all: everyone with an address; the linked account's address and admin flag", () => {
    const r = summaryRecipients({ mode: "all", people, members, present });
    expect(r.map((x) => [x.person.id, x.email, x.missed, x.isAdmin])).toEqual([
      ["p-anna", "anna@konto.se", false, true],
      ["p-erik", "p-erik@example.com", false, false],
      ["p-sara", "p-sara@example.com", true, false],
    ]);
  });

  it("selected: only ticked people; off: nobody", () => {
    const ticked = people.map((p) => (p.id === "p-erik" || p.id === "p-nils" ? { ...p, summary_selected: true } : p));
    expect(summaryRecipients({ mode: "selected", people: ticked, members, present }).map((x) => x.person.id)).toEqual(["p-erik"]);
    expect(summaryRecipients({ mode: "off", people, members, present })).toEqual([]);
  });

  it("unsubscribed people never get it, in any mode", () => {
    const gone = people.map((p) => (p.id === "p-sara" ? { ...p, summary_unsubscribed_at: "2026-11-01T00:00:00Z", summary_selected: true } : p));
    for (const mode of ["missed", "all", "selected"] as const) {
      expect(summaryRecipients({ mode, people: gone, members, present }).map((x) => x.person.id)).not.toContain("p-sara");
    }
  });

  it("missed with nobody identified sends nothing; all then uses neutral wording for everyone", () => {
    expect(summaryRecipients({ mode: "missed", people, members, present: new Set() })).toEqual([]);
    expect(summaryRecipients({ mode: "all", people, members, present: new Set() }).every((r) => !r.missed)).toBe(true);
  });

  it("the same address twice is mailed once", () => {
    const dup = [...people, P("p-sara2", "Sara Two", { email: "P-SARA@example.com" })];
    expect(summaryRecipients({ mode: "all", people: dup, members, present }).filter((r) => r.email.toLowerCase() === "p-sara@example.com")).toHaveLength(1);
  });

  it("a linked account that left falls back to the person's own address", () => {
    const left = [P("p-x", "Xena", { member_user_id: "u-gone", email: "x@example.com" })];
    expect(summaryRecipients({ mode: "all", people: left, members, present: new Set(["p-other"]) }).map((r) => r.email)).toEqual(["x@example.com"]);
  });
});

describe("summaryOptions", () => {
  it("lists everyone by name with whether they can get e-mail", () => {
    const o = summaryOptions([nils, anna, { ...sara, summary_selected: true, summary_unsubscribed_at: "x" }], members);
    expect(o.map((x) => [x.name, x.hasEmail, x.selected, x.unsubscribed])).toEqual([
      ["Anna Berg", true, false, false],
      ["Nils Ek", false, false, false],
      ["Sara Holm", true, true, true],
    ]);
  });
});
