import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { historySummary, loadImportedHistory, saveImportedProtocol, setProtocolDate } from "@/lib/history/store";
import { createOrg, joinOrg } from "@/lib/db/orgs";

// Imported protocols (0032) against the local stack. Fictional data only.

const items = (text: string) => [
  { kind: "topic", text: "Spelkafé", topic: null, owner: null, done: null },
  { kind: "decision", text, topic: "Spelkafé", owner: null, done: null },
  { kind: "task", text: "Kontakta biblioteket", topic: "Spelkafé", owner: "Eventansvarig", done: false },
] as const;

describe.skipIf(!hasLocalSupabase)("imported protocols (0032)", () => {
  let admin: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let orgId: string;

  beforeAll(async () => {
    [admin, member, outsider] = await Promise.all([createTestUser("hadmin"), createTestUser("hmember"), createTestUser("houtsider")]);
    const r = await createOrg(admin.db, "Brädspelsföreningen Rutan");
    if (!r.ok) throw new Error("org setup failed");
    orgId = r.id;
    const { data } = await adminClient().from("orgs").select("invite_code").eq("id", orgId).single();
    expect(await joinOrg(member.db, data!.invite_code as string)).toBe(orgId);
  });

  it("save: admin stores, a re-import of the same Doc replaces it, members read, outsiders do not", async () => {
    const a = await saveImportedProtocol(admin.db, { orgId, driveFileId: "doc-aaaaaaaaaa", date: "2025-09-02", section: 0, sections: 1, dateFrom: "doc", items: [...items("Starta spelkafé")] });
    expect(a.ok).toBe(true);
    await saveImportedProtocol(admin.db, { orgId, driveFileId: "doc-bbbbbbbbbb", date: "2025-08-26", section: 0, sections: 1, dateFrom: "file", items: [...items("Första beslutet")] });
    const again = await saveImportedProtocol(admin.db, { orgId, driveFileId: "doc-aaaaaaaaaa", date: "2025-09-02", section: 0, sections: 1, dateFrom: "doc", items: [...items("Starta spelkafé, version 2")] });
    expect(again.ok).toBe(true);

    expect(await historySummary(member.db, orgId)).toEqual({ count: 2, first: "2025-08-26", last: "2025-09-02" });
    const h = await loadImportedHistory(member.db, orgId);
    expect(h.map((m) => m.date)).toEqual(["2025-08-26", "2025-09-02"]);
    expect(h[1].items).toEqual([...items("Starta spelkafé, version 2")]);
    expect(await historySummary(outsider.db, orgId)).toEqual({ count: 0, first: null, last: null });
  });

  it("members cannot save or clear, nobody writes the tables directly, bad input refused", async () => {
    const denied = await saveImportedProtocol(member.db, { orgId, driveFileId: "doc-cccccccccc", date: "2025-09-09", section: 0, sections: 1, dateFrom: "doc", items: [] });
    expect(denied).toMatchObject({ ok: false, code: "42501" });
    expect((await member.db.rpc("clear_history_protocols", { p_org_id: orgId })).error?.code).toBe("42501");
    const ins = await admin.db.from("history_protocols").insert({ org_id: orgId, drive_file_id: "doc-dddddddddd", meeting_date: "2025-01-01", date_from: "doc" });
    expect(ins.error).not.toBeNull();
    const badKind = await saveImportedProtocol(admin.db, {
      orgId,
      driveFileId: "doc-eeeeeeeeee",
      date: "2025-09-09",
      section: 0,
      sections: 1,
      dateFrom: "doc",
      items: [{ kind: "rant" as never, text: "x", topic: null, owner: null, done: null }],
    });
    expect(badKind.ok).toBe(false);
    const badId = await saveImportedProtocol(admin.db, { orgId, driveFileId: "x", date: "2025-09-09", section: 0, sections: 1, dateFrom: "doc", items: [] });
    expect(badId.ok).toBe(false);
    expect((await historySummary(admin.db, orgId)).count).toBe(2);
  });

  it("a running Doc: one row per section; a re-import with fewer sections drops the extra ones; future dates refused", async () => {
    const save = (section: number, sections: number, date: string) =>
      saveImportedProtocol(admin.db, { orgId, driveFileId: "doc-running01", section, sections, date, dateFrom: "doc", items: [...items(`Möte ${section}`)] });
    for (let k = 0; k < 3; k++) expect((await save(k, 3, `2025-10-0${k + 1}`)).ok).toBe(true);
    expect((await historySummary(admin.db, orgId)).count).toBe(5);
    // The Doc now splits into 2: saving section 0 of 2 removes section 2.
    expect((await save(0, 2, "2025-10-01")).ok).toBe(true);
    expect((await historySummary(admin.db, orgId)).count).toBe(4);
    expect((await save(0, 2, "2099-01-01")).ok).toBe(false);
    expect((await save(2, 2, "2025-10-01")).ok).toBe(false);
    // Back to the two plain Docs for the next tests.
    const { data } = await adminClient().from("history_protocols").select("id").eq("drive_file_id", "doc-running01");
    for (const r of data ?? []) await adminClient().from("history_protocols").delete().eq("id", r.id);
  });

  it("set_history_protocol_date: admin corrects a file date (date_from admin), member denied, no future dates", async () => {
    const { data } = await adminClient().from("history_protocols").select("id").eq("org_id", orgId).eq("drive_file_id", "doc-bbbbbbbbbb").single();
    const pid = data!.id as string;
    expect(await setProtocolDate(member.db, orgId, pid, "2025-08-20")).toEqual({ ok: false, code: "42501" });
    expect((await setProtocolDate(admin.db, orgId, pid, "2099-08-20")).ok).toBe(false);
    expect(await setProtocolDate(admin.db, orgId, pid, "2025-08-20")).toEqual({ ok: true, code: null });
    const row = await adminClient().from("history_protocols").select("meeting_date, date_from").eq("id", pid).single();
    expect(row.data).toEqual({ meeting_date: "2025-08-20", date_from: "admin" });
  });

  it("claim_history_import: admins only, 60 per 24 h; only the service role gives a claim back", async () => {
    expect((await member.db.rpc("claim_history_import", { p_org_id: orgId })).error?.code).toBe("42501");
    const rows = Array.from({ length: 59 }, () => ({ org_id: orgId }));
    await adminClient().from("history_import_claims").insert(rows);
    const last = (await admin.db.rpc("claim_history_import", { p_org_id: orgId })).data;
    expect(typeof last).toBe("number");
    expect((await admin.db.rpc("claim_history_import", { p_org_id: orgId })).data).toBeNull();
    // Only the server (service role) gives a claim back: an admin's browser cannot lift the cap.
    expect((await member.db.rpc("release_history_import", { p_org_id: orgId, p_claim_id: last })).error).not.toBeNull();
    expect((await admin.db.rpc("release_history_import", { p_org_id: orgId, p_claim_id: last })).error).not.toBeNull();
    expect((await adminClient().rpc("release_history_import", { p_org_id: orgId, p_claim_id: last })).data).toBe(true);
    expect(typeof (await admin.db.rpc("claim_history_import", { p_org_id: orgId })).data).toBe("number");
    expect((await admin.db.from("history_import_claims").select("id")).error).not.toBeNull();
  });

  it("clear: admin removes every imported protocol and its items", async () => {
    const { data, error } = await admin.db.rpc("clear_history_protocols", { p_org_id: orgId });
    expect(error).toBeNull();
    expect(data).toBe(2);
    expect(await loadImportedHistory(admin.db, orgId)).toEqual([]);
    const { count } = await adminClient().from("history_items").select("*", { count: "exact", head: true }).eq("org_id", orgId);
    expect(count).toBe(0);
  });
});
