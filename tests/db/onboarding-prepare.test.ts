import { beforeAll, describe, expect, it, vi } from "vitest";
import { createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { createOrg } from "@/lib/db/orgs";
import { ARSMOTE, STYRELSEPROTOKOLL } from "@/lib/formats/standard";

// Onboarding step 4 → Förbered möte: the förening's own Styrelsemöte / Årsmöte (from the
// stadgar, 0035) are used for those types while Veckomöte stays the default. Fictional data.

vi.mock("@/lib/supabase/admin", async () => ({ supabaseAdmin: (await import("@/test/local-supabase")).adminClient }));
const { formatForType } = await import("@/lib/prepare/prepare");
const { chooseStandardFormat } = await import("@/lib/formats/store");
const { arsmoteProfile } = await import("@/lib/formats/arsmote-profile");

describe.skipIf(!hasLocalSupabase)("Förbered möte uses the förening's own types (0035)", () => {
  let admin: TestUser;
  let orgId: string;

  beforeAll(async () => {
    admin = await createTestUser("ob-prep");
    const r = await createOrg(admin.db, "Typföreningen");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
    await chooseStandardFormat(admin.db, orgId, "veckomote");
  });

  it("without own versions: the standards", async () => {
    expect((await formatForType(orgId, "arsmote")).profile).toEqual(ARSMOTE);
    expect((await formatForType(orgId, "styrelsemote")).profile).toEqual(STYRELSEPROTOKOLL);
  });

  it("with them (a Styrelsemöte one saved before todo #15): each type follows its own; Veckomöte stays the default", async () => {
    const ars = arsmoteProfile(["Mötets öppnande", "Fastställande av medlemsavgift"]);
    const { data: arsId } = await admin.db.rpc("set_type_format", { p_org_id: orgId, p_type: "arsmote", p_profile: ars });
    const { data: styrId } = await admin.db.rpc("set_type_format", {
      p_org_id: orgId,
      p_type: "styrelsemote",
      p_profile: { ...STYRELSEPROTOKOLL, requiredItems: ["Fråga om beslutsmässighet"] },
    });
    const a = await formatForType(orgId, "arsmote");
    expect(a.id).toBe(arsId);
    expect(a.profile.fixedAgendaItems.map((i) => i.label)).toContain("Fastställande av medlemsavgift");
    const s = await formatForType(orgId, "styrelsemote");
    expect(s.id).toBe(styrId);
    expect(s.profile.requiredItems).toEqual(["Fråga om beslutsmässighet"]);
    expect((await formatForType(orgId, "veckomote")).profile.kind).toBe("veckomote");
  });

  it("a förening whose default is Styrelseprotokoll keeps it for its ordinary meeting (todo #15)", async () => {
    const r = await createOrg(admin.db, "Styrelseföreningen");
    if (!r.ok) throw new Error("org");
    await chooseStandardFormat(admin.db, r.id, "styrelseprotokoll");
    const v = await formatForType(r.id, "veckomote");
    expect(v.id).not.toBeNull();
    expect(v.profile).toEqual(STYRELSEPROTOKOLL);
  });
});
