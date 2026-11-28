import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestEnv } from "@/test/env";

useTestEnv();

// Fictional förening: admins Anna (replaced the account), Erik and Lisa (no mail at all); member Mia.

const g = vi.hoisted(() => ({ allOff: new Set<string>() }));
vi.mock("@/lib/db/members", () => ({
  orgMemberList: async () => [
    { userId: "u-anna", email: "anna@ekdala.test", role: "admin" },
    { userId: "u-erik", email: "erik@ekdala.test", role: "admin" },
    { userId: "u-lisa", email: "lisa@ekdala.test", role: "admin" },
    { userId: "u-mia", email: "mia@ekdala.test", role: "member" },
  ],
}));
// The gate: Lisa turned admin_notice (or all mail) off.
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({ rpc: async (_: string, a: { p_user_id: string; p_category: string }) => ({ data: a.p_category === "admin_notice" && !g.allOff.has(a.p_user_id), error: null }) }),
}));

const { notifyDriveAccountReplaced } = await import("./drive-account-notify");

const notice = { orgId: "org-1", orgName: "Ekdala IF", byUserId: "u-anna", byName: "Anna Berg", oldEmail: "gamla@ekdala.test", newEmail: "ny@ekdala.test" };

describe("notifyDriveAccountReplaced", () => {
  beforeEach(() => {
    g.allOff = new Set(["u-lisa"]);
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("the other admins only, not the replacer or members, through the admin_notice gate; says both accounts", async () => {
    const send = vi.fn(async () => true);
    expect(await notifyDriveAccountReplaced(notice, { send })).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    const mail = (send.mock.calls[0] as unknown as [{ to: string; subject: string; text: string }])[0];
    expect(mail.to).toBe("erik@ekdala.test");
    expect(mail.subject).toBe("Ekdala IF: Drive-kontot byttes");
    expect(mail.text).toContain("Anna Berg bytte Google-kontot");
    expect(mail.text).toContain("från gamla@ekdala.test till ny@ekdala.test");
    expect(mail.text).toContain("https://example.com/orgs/org-1?flik=installningar&del=moten");
  });
});
