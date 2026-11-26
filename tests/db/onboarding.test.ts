import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { createOrg, joinOrg } from "@/lib/db/orgs";
import { ARSMOTE, STYRELSEPROTOKOLL } from "@/lib/formats/standard";

// Onboarding (todo #5, migration 0035): the onboarding row, the board list's e-mail link to a
// member account, voice consent, per-type formats and the org-logos bucket. Fictional data.

async function inviteCode(orgId: string): Promise<string> {
  const { data } = await adminClient().from("orgs").select("invite_code").eq("id", orgId).single();
  return data!.invite_code as string;
}

async function newOrg(admin: TestUser, name: string): Promise<string> {
  const r = await createOrg(admin.db, name);
  if (!r.ok) throw new Error("org");
  return r.id;
}

async function person(orgId: string, name: string): Promise<string> {
  const { data, error } = await adminClient().from("people").insert({ org_id: orgId, name }).select("id").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

async function personRow(id: string) {
  const { data } = await adminClient().from("people").select("email, member_user_id, voice_consent_at, voice_consent_by").eq("id", id).single();
  return data!;
}

const png = () => new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])], { type: "image/png" });

describe.skipIf(!hasLocalSupabase)("onboarding (0035)", () => {
  let admin: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let orgId: string;

  beforeAll(async () => {
    [admin, member, outsider] = await Promise.all([createTestUser("ob-adm"), createTestUser("ob-mem"), createTestUser("ob-out")]);
    orgId = await newOrg(admin, "Kom igång-föreningen");
    expect(await joinOrg(member.db, await inviteCode(orgId))).toBe(orgId);
  });

  it("a new förening gets an onboarding row; members read it, only admins change it", async () => {
    const { data } = await member.db.from("org_onboarding").select("done, skipped, completed_at").eq("org_id", orgId).single();
    expect(data).toMatchObject({ done: [], skipped: [], completed_at: null });

    const { data: denied } = await member.db.from("org_onboarding").update({ done: ["namn"] }).eq("org_id", orgId).select("org_id");
    expect(denied ?? []).toHaveLength(0);

    const { data: ok, error } = await admin.db.from("org_onboarding").update({ done: ["namn"], skipped: ["mapp"] }).eq("org_id", orgId).select("done");
    expect(error).toBeNull();
    expect(ok?.[0]?.done).toEqual(["namn"]);

    const { error: bad } = await admin.db.from("org_onboarding").update({ done: ["okand"] }).eq("org_id", orgId);
    expect(bad?.code).toBe("23514");

    const { data: hidden } = await outsider.db.from("org_onboarding").select("org_id").eq("org_id", orgId);
    expect(hidden ?? []).toHaveLength(0);
  });

  it("an e-mail on a board person links them to the member with that address", async () => {
    const p = await person(orgId, "Erik Lund");
    expect((await member.db.rpc("set_person_email", { p_person_id: p, p_email: member.email })).data).toBe("forbidden");
    expect((await admin.db.rpc("set_person_email", { p_person_id: p, p_email: "inte-en-adress" })).data).toBe("invalid");
    expect((await admin.db.rpc("set_person_email", { p_person_id: p, p_email: ` ${member.email.toUpperCase()} ` })).data).toBe("ok");
    expect(await personRow(p)).toMatchObject({ email: member.email.toLowerCase(), member_user_id: member.id });

    const q = await person(orgId, "Sara Nyström");
    expect((await admin.db.rpc("set_person_email", { p_person_id: q, p_email: member.email })).data).toBe("taken");
    // Clearing the e-mail keeps the link (the account is still that person's).
    expect((await admin.db.rpc("set_person_email", { p_person_id: p, p_email: "" })).data).toBe("ok");
    expect(await personRow(p)).toMatchObject({ email: null, member_user_id: member.id });
  });

  it("someone invited by e-mail is linked when they join", async () => {
    const newcomer = await createTestUser("ob-new");
    const p = await person(orgId, "Johan Ek");
    expect((await admin.db.rpc("set_person_email", { p_person_id: p, p_email: newcomer.email })).data).toBe("ok");
    expect((await personRow(p)).member_user_id).toBeNull();
    expect(await joinOrg(newcomer.db, await inviteCode(orgId))).toBe(orgId);
    expect((await personRow(p)).member_user_id).toBe(newcomer.id);
  });

  it("voice consent: an admin or the person's own account records it, others cannot", async () => {
    const p = await person(orgId, "Anna Berg");
    expect((await member.db.rpc("set_voice_consent", { p_person_id: p, p_consent: true })).data).toBe(false);
    expect((await outsider.db.rpc("set_voice_consent", { p_person_id: p, p_consent: true })).data).toBe(false);
    expect((await admin.db.rpc("set_voice_consent", { p_person_id: p, p_consent: true })).data).toBe(true);
    const row = await personRow(p);
    expect(row.voice_consent_at).not.toBeNull();
    expect(row.voice_consent_by).toBe(admin.id);
    expect((await admin.db.rpc("set_voice_consent", { p_person_id: p, p_consent: false })).data).toBe(true);
    expect(await personRow(p)).toMatchObject({ voice_consent_at: null, voice_consent_by: null });

    // A member may answer for the person linked to their own account.
    await adminClient().from("people").update({ member_user_id: member.id }).eq("id", p);
    await adminClient().from("people").update({ member_user_id: null }).neq("id", p).eq("org_id", orgId).eq("member_user_id", member.id);
    expect((await member.db.rpc("set_voice_consent", { p_person_id: p, p_consent: true })).data).toBe(true);
  });

  it("set_type_format stores a non-default version and points the förening at it (admins only)", async () => {
    const ars = { ...ARSMOTE, fixedAgendaItems: ARSMOTE.fixedAgendaItems.slice(0, 4) };
    const { error: denied } = await member.db.rpc("set_type_format", { p_org_id: orgId, p_type: "arsmote", p_profile: ars });
    expect(denied?.code).toBe("42501");
    const { error: mismatch } = await admin.db.rpc("set_type_format", { p_org_id: orgId, p_type: "arsmote", p_profile: STYRELSEPROTOKOLL });
    expect(mismatch?.code).toBe("22023");

    const { data: arsId, error } = await admin.db.rpc("set_type_format", { p_org_id: orgId, p_type: "arsmote", p_profile: ars });
    expect(error).toBeNull();
    const { data: styrId } = await admin.db.rpc("set_type_format", {
      p_org_id: orgId,
      p_type: "styrelsemote",
      p_profile: { ...STYRELSEPROTOKOLL, requiredItems: ["Fråga om beslutsmässighet"] },
    });
    const { data: org } = await adminClient().from("orgs").select("arsmote_format_id, styrelse_format_id").eq("id", orgId).single();
    expect(org).toEqual({ arsmote_format_id: arsId, styrelse_format_id: styrId });
    const { data: rows } = await adminClient().from("format_profiles").select("is_default, approved_by").in("id", [arsId, styrId]);
    expect(rows?.every((r) => r.is_default === false && r.approved_by === admin.id)).toBe(true);
  });

  it("org-logos: admins write their förening's logo, members read it, nobody else", async () => {
    const path = `${orgId}/logo`;
    const up = await member.db.storage.from("org-logos").upload(path, png(), { contentType: "image/png", upsert: true });
    expect(up.error).not.toBeNull();

    const ok = await admin.db.storage.from("org-logos").upload(path, png(), { contentType: "image/png", upsert: true });
    expect(ok.error).toBeNull();
    const again = await admin.db.storage.from("org-logos").upload(path, png(), { contentType: "image/png", upsert: true });
    expect(again.error).toBeNull();

    const bad = await admin.db.storage.from("org-logos").upload(`${orgId}/annat.png`, png(), { contentType: "image/png" });
    expect(bad.error).not.toBeNull();
    const svg = await admin.db.storage
      .from("org-logos")
      .upload(path, new Blob(["<svg/>"], { type: "image/svg+xml" }), { contentType: "image/svg+xml", upsert: true });
    expect(svg.error).not.toBeNull();

    const read = await member.db.storage.from("org-logos").download(path);
    expect(read.error).toBeNull();
    const outside = await outsider.db.storage.from("org-logos").download(path);
    expect(outside.error).not.toBeNull();

    const other = await newOrg(outsider, "Annan förening");
    const cross = await admin.db.storage.from("org-logos").upload(`${other}/logo`, png(), { contentType: "image/png", upsert: true });
    expect(cross.error).not.toBeNull();

    const { error: rm } = await admin.db.storage.from("org-logos").remove([path]);
    expect(rm).toBeNull();
  });
});
