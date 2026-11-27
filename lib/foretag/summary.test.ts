import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({}) }));
vi.mock("@/lib/db/foretag", () => ({ createTaskHandoffs: vi.fn(), viewerIds: vi.fn() }));
const { foretagSummaryPeople, taskOwners } = await import("./summary");

describe("foretagSummaryPeople", () => {
  const people = [
    { id: "p-anna", name: "Anna", member_user_id: "anna" },
    { id: "p-erik", name: "Erik", member_user_id: "erik" },
    { id: "p-jonas", name: "Jonas", member_user_id: "jonas" },
    { id: "p-maja", name: "Maja", member_user_id: "maja" },
    { id: "p-gast", name: "Gäst", member_user_id: null },
  ];
  const personGroups = new Map<string, string | null>([
    ["p-anna", "vd"],
    ["p-erik", "led"],
    ["p-jonas", "dev"],
    ["p-maja", "com"],
    ["p-gast", "dev"],
  ]);
  it("a Utveckling meeting mails Utveckling, not the heads or the CEO above, never a cousin", () => {
    const out = foretagSummaryPeople(people, { groupId: "dev", attendeeIds: ["jonas"], viewerIds: ["anna", "erik", "jonas"], personGroups });
    expect(out.map((p) => p.name)).toEqual(["Jonas"]);
  });
  it("a Privat möte mails only attendees who can see it", () => {
    const out = foretagSummaryPeople(people, { groupId: "led", attendeeIds: ["anna", "maja"], viewerIds: ["anna"], personGroups });
    expect(out.map((p) => p.name)).toEqual(["Anna"]);
  });
  it("keeps the rows' own fields", () => {
    const out = foretagSummaryPeople(people, { groupId: null, attendeeIds: [], viewerIds: ["erik"], personGroups });
    expect(out).toEqual([expect.objectContaining({ id: "p-erik", name: "Erik" })]);
  });
});

describe("taskOwners", () => {
  const people = [{ id: "p-maja", name: "Maja", role: null }];
  it("a person's edited line goes to approval without our placeholders; an AI row's text is the database's own", () => {
    const out = taskOwners(
      [
        { id: "t1", section: "action", text: "(vem?): Boka lokal (deadline?) – (klart när?).", locked: true, owner: null, owner_person_id: "p-maja" },
        { id: "t2", section: "action", text: "Maja gör bilden", locked: false, owner: "Maja", owner_person_id: null },
        { id: "t3", section: "action", text: "Klar sak", owner: null, owner_person_id: "p-maja", done: true },
      ],
      people as never,
    );
    expect(out).toEqual([
      { item_id: "t1", person_id: "p-maja", text: "Boka lokal." },
      { item_id: "t2", person_id: "p-maja" },
    ]);
  });
});
