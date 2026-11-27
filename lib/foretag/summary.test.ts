import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({}) }));
vi.mock("@/lib/db/foretag", () => ({ createTaskHandoffs: vi.fn(), viewerIds: vi.fn() }));
const { foretagSummaryPeople } = await import("./summary");

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
