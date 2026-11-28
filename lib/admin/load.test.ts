import { beforeAll, describe, expect, it, vi } from "vitest";
import { testEnv } from "@/test/env";

const rpc = vi.fn(async () => ({ data: {}, error: null }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ rpc }) }));

beforeAll(() => {
  Object.assign(process.env, testEnv, { ADMIN_EMAILS: "boss@example.com" });
});

const { loadAdminDashboard, NotAdminError } = await import("./load");

describe("loadAdminDashboard (the admin gate)", () => {
  it("refuses everyone outside ADMIN_EMAILS before any service-role call", async () => {
    for (const email of [null, "", "member@example.com", testEnv.ALARM_EMAIL]) {
      await expect(loadAdminDashboard(email)).rejects.toBeInstanceOf(NotAdminError);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reads both aggregates for an admin", async () => {
    const data = await loadAdminDashboard("Boss@Example.com");
    expect(rpc.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["admin_overview", "admin_org_stats"]);
    expect(data.orgs).toEqual([]);
  });
});
