import { describe, expect, it } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase } from "@/test/local-supabase";
import { createOrg, listMyOrgs } from "@/lib/db/orgs";

// 0064: the create limits (10 existing, 30 ever; 0041) count föreningar only. Companies (0050) are
// gated by the allow-list and made with the service role: they neither count nor are counted.
// Privat (0045) stays outside both.

const must = <T>(what: string, r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

describe.skipIf(!hasLocalSupabase)("org limits per kind (0064)", () => {
  it("companies don't count: 30 companies, then 10 föreningar still fit, the 11th is refused", async () => {
    const user = await createTestUser("limit-kind");
    const admin = adminClient();
    for (let i = 1; i <= 30; i++)
      must(`company ${i}`, await admin.rpc("create_foretag", { p_user: user.id, p_name: `Bolag ${i}`, p_root_name: "Ledning", p_person_name: "Ägare" }));
    // Before 0064 the first förening was already refused (30 rows in the ledger, 30 orgs).
    for (let i = 1; i <= 10; i++) expect((await createOrg(user.db, `Förening ${i}`)).ok, `förening ${i}`).toBe(true);
    expect(await createOrg(user.db, "Elva")).toEqual({ ok: false, reason: "limit" });
    expect(await listMyOrgs(user.db)).toHaveLength(10);
    // Privat is still made (and is no creation in the ledger).
    expect(must("privat", await user.db.rpc("ensure_my_privat_space"))).toEqual(expect.any(String));
    const ledger = must("ledger", await admin.from("org_creations").select("kind").eq("user_id", user.id)) as { kind: string }[];
    expect(ledger.filter((r) => r.kind === "foretag")).toHaveLength(30);
    expect(ledger.filter((r) => r.kind === "forening")).toHaveLength(10);
    expect(ledger).toHaveLength(40);
  });

  it("companies stay unlimited for the allow-listed creator (service role) past ten", async () => {
    const user = await createTestUser("limit-foretag");
    const admin = adminClient();
    for (let i = 1; i <= 10; i++) expect((await createOrg(user.db, `F ${i}`)).ok).toBe(true);
    // At the förening limit, a company is still made.
    must("company", await admin.rpc("create_foretag", { p_user: user.id, p_name: "Bolag", p_root_name: "Ledning", p_person_name: "Ägare" }));
    expect(await createOrg(user.db, "Elva")).toEqual({ ok: false, reason: "limit" });
  });

  it("a client still can't make a company itself (orgs.kind isn't client-writable)", async () => {
    const user = await createTestUser("limit-kind-spoof");
    const { error } = await user.db.from("orgs").insert({ name: "Bolag", kind: "foretag", created_by: user.id });
    expect(error).not.toBeNull();
  });
});
