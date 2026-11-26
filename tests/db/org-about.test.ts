import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { createOrg, getOrg, joinOrg, updateOrgSettings } from "@/lib/db/orgs";
import { parseProfile } from "@/lib/orgs/profile";

// "Om oss" (todo #13, migration 0044): admins set the text and links through the normal org
// update (column grant + orgs_update); members read them; the checks refuse anything but the
// canonical https form. Fictional data.

describe.skipIf(!hasLocalSupabase)("org about (0044)", () => {
  let admin: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let orgId: string;

  beforeAll(async () => {
    [admin, member, outsider] = await Promise.all([createTestUser("about-adm"), createTestUser("about-mem"), createTestUser("about-out")]);
    const r = await createOrg(admin.db, "Om oss-föreningen");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
    const { data } = await adminClient().from("orgs").select("invite_code").eq("id", orgId).single();
    expect(await joinOrg(member.db, data!.invite_code as string)).toBe(orgId);
  });

  it("an admin saves the parsed profile; members read it, outsiders don't", async () => {
    const parsed = parseProfile({ about: "Vi spelar golf.\r\nVarje tisdag.", website: "exempel.se", facebook: "facebook.com/exempel", instagram: "@exempel" });
    if (!parsed.ok) throw new Error("parse");
    expect(await updateOrgSettings(admin.db, orgId, parsed.profile)).toBe(true);

    const org = await getOrg(member.db, orgId);
    expect(org).toMatchObject({
      about: "Vi spelar golf.\nVarje tisdag.",
      website_url: "https://exempel.se/",
      facebook_url: "https://facebook.com/exempel",
      instagram_url: "https://instagram.com/exempel",
    });
    expect(await getOrg(outsider.db, orgId)).toBeNull();
  });

  it("a member can't change it", async () => {
    const { data } = await member.db.from("orgs").update({ about: "Kapad" }).eq("id", orgId).select("id");
    expect(data ?? []).toHaveLength(0);
    const { data: row } = await adminClient().from("orgs").select("about").eq("id", orgId).single();
    expect(row?.about).toBe("Vi spelar golf.\nVarje tisdag.");
  });

  it("clears to null", async () => {
    const { error } = await admin.db.from("orgs").update({ instagram_url: null }).eq("id", orgId);
    expect(error).toBeNull();
  });

  it.each([
    ["about", "x".repeat(601)],
    ["about", ""],
    ["about", "rad 1\r\nrad 2"],
    ["website_url", "http://exempel.se/"],
    ["website_url", "javascript:alert(1)"],
    ["website_url", "https://exempel.se"],
    ["website_url", "https://localhost/"],
    ["facebook_url", "https://www.facebook.com/exempel"],
    ["facebook_url", "https://facebook.com.evil.com/x"],
    ["facebook_url", "https://facebook.com/"],
    ["instagram_url", "https://instagram.com/p/abc"],
    ["instagram_url", "https://evil.com/exempel"],
    ["instagram_url", "http://instagram.com/exempel"],
  ])("the check refuses %s = %j", async (column, value) => {
    const { error } = await admin.db.from("orgs").update({ [column]: value }).eq("id", orgId);
    expect(error?.code).toBe("23514");
  });
});
