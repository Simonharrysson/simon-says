import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createTestUser, hasLocalSupabase, seedMeeting, type TestUser } from "@/test/local-supabase";
import { createOrg, joinOrg } from "@/lib/db/orgs";

// The goals routes against the local stack as real signed-in users. Claude is mocked: the admin
// gate and the too-few-meetings check must stop before any call. Fictional data only.
const m = vi.hoisted(() => ({ db: null as SupabaseClient | null, proposeGoals: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => m.db }));
vi.mock("@/lib/dashboard/goals", () => ({ proposeGoals: m.proposeGoals }));

const propose = (await import("@/app/api/orgs/[id]/goals/propose/route")).POST;
const approve = (await import("@/app/api/orgs/[id]/goals/route")).POST;
const req = (url: string, body?: unknown) =>
  new NextRequest(url, { method: "POST", body: JSON.stringify(body ?? {}), headers: { "content-type": "application/json" } });
const callPropose = (orgId: string) => propose(req(`https://x.test/api/orgs/${orgId}/goals/propose`), { params: Promise.resolve({ id: orgId }) });
const callApprove = (orgId: string, body: unknown) => approve(req(`https://x.test/api/orgs/${orgId}/goals`, body), { params: Promise.resolve({ id: orgId }) });

describe.skipIf(!hasLocalSupabase)("goals routes", () => {
  let admin: TestUser;
  let member: TestUser;
  let orgId: string;

  beforeAll(async () => {
    [admin, member] = await Promise.all([createTestUser("gadmin"), createTestUser("gmember")]);
    const r = await createOrg(admin.db, "Spelföreningen Kortleken");
    if (!r.ok) throw new Error("org setup failed");
    orgId = r.id;
    const { data } = await adminClient().from("orgs").select("invite_code").eq("id", orgId).single();
    expect(await joinOrg(member.db, data!.invite_code as string)).toBe(orgId);
  });

  beforeEach(() => {
    m.proposeGoals.mockReset();
    m.proposeGoals.mockResolvedValue({ ok: true, goals: [{ title: "Fler spelkvällar", why: null }], explanation: "x", usage: {} });
  });

  it("propose: a member gets 403 and no Claude call", async () => {
    m.db = member.db;
    const res = await callPropose(orgId);
    expect(res.status).toBe(403);
    expect(m.proposeGoals).not.toHaveBeenCalled();
  });

  it("propose: fewer than 3 ended meetings → 409 and no Claude call; with 3 → the proposal", async () => {
    m.db = admin.db;
    const res = await callPropose(orgId);
    expect(res.status).toBe(409);
    expect(m.proposeGoals).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i++) await seedMeeting(orgId, admin.id);
    const ok = await callPropose(orgId);
    expect(ok.status).toBe(200);
    expect((await ok.json()).goals).toEqual([{ title: "Fler spelkvällar", why: null }]);
    expect(m.proposeGoals).toHaveBeenCalledTimes(1);
  });

  it("approve: admin stores, member denied, bad input refused", async () => {
    m.db = admin.db;
    expect((await callApprove(orgId, { goals: [{ title: " Fler spelkvällar ", why: "" }] })).status).toBe(200);
    expect((await callApprove(orgId, { goals: [{ title: "" }] })).status).toBe(400);
    m.db = member.db;
    expect((await callApprove(orgId, { goals: [] })).status).toBe(403);
    const { data } = await adminClient().from("org_goals").select("title, why").eq("org_id", orgId);
    expect(data).toEqual([{ title: "Fler spelkvällar", why: null }]);
  });
});
