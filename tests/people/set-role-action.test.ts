import { beforeEach, describe, expect, it, vi } from "vitest";

// F9 / spec G5: roles are set by the org's admin. The DB lets members update people (rename), so
// the server action is the gate: a member is refused and nothing is written.
const ORG = "11111111-1111-4111-8111-111111111111";
const PERSON = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  role: "member" as "admin" | "member" | null,
  setPersonRole: vi.fn(async () => true),
  people: [] as { id: string }[],
}));

class Redirect extends Error {}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Redirect(url), { url });
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({}) }));
vi.mock("@/lib/formats/store", () => ({ adoptFormat: vi.fn(), chooseStandardFormat: vi.fn() }));
vi.mock("@/lib/db/orgs", () => ({
  myRole: async () => mocks.role,
  listPeople: async () => mocks.people,
  setPersonRole: mocks.setPersonRole,
}));

import { setPersonRoleAction } from "@/app/(app)/orgs/actions";

function form(role: string, personId = PERSON) {
  const f = new FormData();
  f.set("orgId", ORG);
  f.set("personId", personId);
  f.set("role", role);
  return f;
}

async function redirected(f: FormData): Promise<string | null> {
  try {
    await setPersonRoleAction(f);
    return null;
  } catch (e) {
    return (e as { url?: string }).url ?? null;
  }
}

describe("setPersonRoleAction", () => {
  beforeEach(() => {
    mocks.role = "admin";
    mocks.people = [{ id: PERSON }];
    mocks.setPersonRole.mockClear();
  });

  it("refuses a member and writes nothing", async () => {
    mocks.role = "member";
    expect(await redirected(form("Kassör"))).toBe(`/orgs/${ORG}?fel=roll-admin`);
    expect(mocks.setPersonRole).not.toHaveBeenCalled();
  });

  it("lets an admin set a cleaned role and clear it", async () => {
    expect(await redirected(form(" Kassör "))).toBeNull();
    expect(mocks.setPersonRole).toHaveBeenLastCalledWith(expect.anything(), PERSON, "Kassör");
    expect(await redirected(form(""))).toBeNull();
    expect(mocks.setPersonRole).toHaveBeenLastCalledWith(expect.anything(), PERSON, null);
  });

  it("rejects an invalid role and a person from another org", async () => {
    expect(await redirected(form("Kassör: x"))).toBe(`/orgs/${ORG}?fel=rollnamn`);
    mocks.people = [];
    expect(await redirected(form("Kassör"))).toBe(`/orgs/${ORG}?fel=rollnamn`);
    expect(mocks.setPersonRole).not.toHaveBeenCalled();
  });
});
