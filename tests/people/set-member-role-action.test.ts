import { beforeEach, describe, expect, it, vi } from "vitest";

// Todo #8: the admin-handover action maps the DB's answer to a notice; bad input never reaches it.
const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({
  setMemberRole: vi.fn(async (): Promise<string> => "ok"),
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
vi.mock("@/lib/db/orgs", () => ({ setMemberRole: mocks.setMemberRole }));

import { setMemberRoleAction } from "@/app/(app)/orgs/actions";

function form(role: string, userId = USER) {
  const f = new FormData();
  f.set("orgId", ORG);
  f.set("userId", userId);
  f.set("role", role);
  return f;
}

async function redirected(f: FormData): Promise<string | null> {
  try {
    await setMemberRoleAction(f);
    return null;
  } catch (e) {
    return (e as { url?: string }).url ?? null;
  }
}

describe("setMemberRoleAction", () => {
  beforeEach(() => {
    mocks.setMemberRole.mockReset();
    mocks.setMemberRole.mockResolvedValue("ok");
  });

  it("makes a member admin", async () => {
    expect(await redirected(form("admin"))).toBe(`/orgs/${ORG}?klart=admin-ny`);
    expect(mocks.setMemberRole).toHaveBeenCalledWith({}, ORG, USER, "admin");
  });

  it("takes admin away", async () => {
    expect(await redirected(form("member"))).toBe(`/orgs/${ORG}?klart=admin-bort`);
  });

  it("shows the last-admin refusal", async () => {
    mocks.setMemberRole.mockResolvedValue("last_admin");
    expect(await redirected(form("member"))).toBe(`/orgs/${ORG}?fel=admin-last_admin`);
  });

  it("refuses a bad role or user id without calling the DB", async () => {
    expect(await redirected(form("owner"))).toBe(`/orgs/${ORG}?fel=admin-invalid`);
    expect(await redirected(form("admin", "nope"))).toBe(`/orgs/${ORG}?fel=admin-invalid`);
    expect(mocks.setMemberRole).not.toHaveBeenCalled();
  });
});
