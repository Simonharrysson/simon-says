import { describe, expect, it } from "vitest";
import { attendeeNames, peopleNamed, presentPeople, summaryOptions, summaryRecipients, type SummaryPerson } from "./recipients";

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
    expect([...present.present].sort()).toEqual(["p-anna", "p-erik", "p-sara"]);
    // speaker_2 was never named: we don't know who it was.
    expect([present.certain, present.unnamedVoices]).toEqual([false, 1]);
  });

  it("a shared mic with unnamed 'Talare' voices is uncertain; the starter alone identifies nobody", () => {
    const shared = presentPeople({
      people,
      speakers: [
        { el_session_id: "s1", speaker_label: "speaker_0", person_id: null, display_name: "Talare 1" },
        { el_session_id: "s1", speaker_label: "speaker_1", person_id: null, display_name: "Talare 2" },
      ],
      attendeeNames: [],
      startedBy: "u-anna",
    });
    expect([[...shared.present], shared.certain, shared.unnamedVoices]).toEqual([["p-anna"], false, 2]);
    const unsure = presentPeople({
      people,
      speakers: [
        { el_session_id: "s1", speaker_label: "speaker_0", person_id: "p-erik", display_name: "Erik" },
        { el_session_id: "s1", speaker_label: "speaker_1", person_id: "p-sara", display_name: "Sara?", needs_confirm: true },
      ],
      attendeeNames: [],
      startedBy: null,
    });
    expect(unsure.certain).toBe(false);
    const alone = presentPeople({ people, speakers: [], attendeeNames: [], startedBy: "u-anna" });
    expect([[...alone.present], alone.certain]).toEqual([["p-anna"], false]);
  });

  it("Närvarande text that names nobody in the list ('hela styrelsen', 'alla', a stranger) is not attendance", () => {
    for (const text of ["hela styrelsen", "Alla", "Kalle Okänd"]) {
      const a = presentPeople({ people, speakers: [], attendeeNames: [text], startedBy: "u-anna" });
      expect([a.certain, a.unmatchedNames], text).toEqual([false, 1]);
    }
    // Even next to a matched name: we can't tell who else was there.
    const mixed = presentPeople({ people, speakers: [], attendeeNames: ["Erik, hela styrelsen"], startedBy: null });
    expect([[...mixed.present], mixed.certain]).toEqual([["p-erik"], false]);
  });

  it("a typed Närvarande list counts everyone in it", () => {
    expect(attendeeNames("Närvarande: Anna, Erik och Sara")).toEqual(["Anna", "Erik", "Sara"]);
    expect(attendeeNames("Nils & Sara Holm")).toEqual(["Nils", "Sara Holm"]);
    const present = presentPeople({ people, speakers: [], attendeeNames: ["Anna Berg, Sara och Nils"], startedBy: null });
    expect([...present.present].sort()).toEqual(["p-anna", "p-nils", "p-sara"]);
    expect(present.certain).toBe(true);
  });

  it("a named voice without a person id is matched by its name", () => {
    const present = presentPeople({
      people,
      speakers: [{ el_session_id: "s1", speaker_label: "speaker_0", person_id: null, display_name: "Nils" }],
      attendeeNames: [],
      startedBy: null,
    });
    expect([...present.present, present.certain]).toEqual(["p-nils", true]);
  });
});

describe("summaryRecipients", () => {
  const present = { present: new Set(["p-anna", "p-erik"]), certain: true };

  it("missed (default): only people with an address who were not there; account address first", () => {
    const r = summaryRecipients({ mode: "missed", people, members, attendance: present });
    expect(r.map((x) => [x.person.id, x.email, x.missed])).toEqual([["p-sara", "p-sara@example.com", true]]);
  });

  it("all: everyone with an address; the linked account's address and admin flag", () => {
    const r = summaryRecipients({ mode: "all", people, members, attendance: present });
    expect(r.map((x) => [x.person.id, x.email, x.missed, x.isAdmin])).toEqual([
      ["p-anna", "anna@konto.se", false, true],
      ["p-erik", "p-erik@example.com", false, false],
      ["p-sara", "p-sara@example.com", true, false],
    ]);
  });

  it("selected: only ticked people; off: nobody", () => {
    const ticked = people.map((p) => (p.id === "p-erik" || p.id === "p-nils" ? { ...p, summary_selected: true } : p));
    expect(summaryRecipients({ mode: "selected", people: ticked, members, attendance: present }).map((x) => x.person.id)).toEqual(["p-erik"]);
    expect(summaryRecipients({ mode: "off", people, members, attendance: present })).toEqual([]);
  });

  it("uncertain attendance: missed sends nothing; all and selected send with neutral wording", () => {
    const unsure = { present: new Set(["p-anna"]), certain: false };
    expect(summaryRecipients({ mode: "missed", people, members, attendance: unsure })).toEqual([]);
    const all = summaryRecipients({ mode: "all", people, members, attendance: unsure });
    expect(all.length).toBe(3);
    expect(all.every((r) => !r.missed)).toBe(true);
    const ticked = people.map((p) => ({ ...p, summary_selected: true }));
    expect(summaryRecipients({ mode: "selected", people: ticked, members, attendance: unsure }).every((r) => !r.missed)).toBe(true);
  });

  it("a person whose membership was removed gets nothing by the old address; re-linked again they do", () => {
    const removed = [P("p-r", "Rut", { member_user_id: null, email: "rut@example.com", summary_removed_at: "2026-11-20T00:00:00Z" })];
    expect(summaryRecipients({ mode: "all", people: removed, members, attendance: present })).toEqual([]);
    const back = [{ ...removed[0], member_user_id: "u-anna" }];
    expect(summaryRecipients({ mode: "all", people: back, members, attendance: present }).map((r) => r.email)).toEqual(["anna@konto.se"]);
  });

  it("the same address twice is mailed once", () => {
    const dup = [...people, P("p-sara2", "Sara Two", { email: "P-SARA@example.com" })];
    expect(summaryRecipients({ mode: "all", people: dup, members, attendance: present }).filter((r) => r.email.toLowerCase() === "p-sara@example.com")).toHaveLength(1);
  });

  it("a linked account that left falls back to the person's own address", () => {
    const left = [P("p-x", "Xena", { member_user_id: "u-gone", email: "x@example.com" })];
    expect(summaryRecipients({ mode: "all", people: left, members, attendance: { present: new Set(["p-other"]), certain: true } }).map((r) => r.email)).toEqual(["x@example.com"]);
  });
});

describe("summaryOptions", () => {
  it("lists everyone by name with whether they can get e-mail", () => {
    const o = summaryOptions([nils, anna, { ...sara, summary_selected: true }], members);
    expect(o.map((x) => [x.name, x.hasEmail, x.selected])).toEqual([
      ["Anna Berg", true, false],
      ["Nils Ek", false, false],
      ["Sara Holm", true, true],
    ]);
  });
});
