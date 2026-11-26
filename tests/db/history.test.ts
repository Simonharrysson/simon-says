import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { historySummary, loadImportedHistory, saveImportedProtocol } from "@/lib/history/store";
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
    const a = await saveImportedProtocol(admin.db, { orgId, driveFileId: "doc-aaaaaaaaaa", date: "2025-09-02", dateFrom: "doc", items: [...items("Starta spelkafé")] });
    expect(a.ok).toBe(true);
    await saveImportedProtocol(admin.db, { orgId, driveFileId: "doc-bbbbbbbbbb", date: "2025-08-26", dateFrom: "file", items: [...items("Första beslutet")] });
    const again = await saveImportedProtocol(admin.db, { orgId, driveFileId: "doc-aaaaaaaaaa", date: "2025-09-02", dateFrom: "doc", items: [...items("Starta spelkafé, version 2")] });
    expect(again.ok).toBe(true);

    expect(await historySummary(member.db, orgId)).toEqual({ count: 2, first: "2025-08-26", last: "2025-09-02" });
    const h = await loadImportedHistory(member.db, orgId);
    expect(h.map((m) => m.date)).toEqual(["2025-08-26", "2025-09-02"]);
    expect(h[1].items).toEqual([...items("Starta spelkafé, version 2")]);
    expect(await historySummary(outsider.db, orgId)).toEqual({ count: 0, first: null, last: null });
  });

  it("members cannot save or clear, nobody writes the tables directly, bad input refused", async () => {
    const denied = await saveImportedProtocol(member.db, { orgId, driveFileId: "doc-cccccccccc", date: "2025-09-09", dateFrom: "doc", items: [] });
    expect(denied).toMatchObject({ ok: false, code: "42501" });
    expect((await member.db.rpc("clear_history_protocols", { p_org_id: orgId })).error?.code).toBe("42501");
    const ins = await admin.db.from("history_protocols").insert({ org_id: orgId, drive_file_id: "doc-dddddddddd", meeting_date: "2025-01-01", date_from: "doc" });
    expect(ins.error).not.toBeNull();
    const badKind = await saveImportedProtocol(admin.db, {
      orgId,
      driveFileId: "doc-eeeeeeeeee",
      date: "2025-09-09",
      dateFrom: "doc",
      items: [{ kind: "rant" as never, text: "x", topic: null, owner: null, done: null }],
    });
    expect(badKind.ok).toBe(false);
    const badId = await saveImportedProtocol(admin.db, { orgId, driveFileId: "x", date: "2025-09-09", dateFrom: "doc", items: [] });
    expect(badId.ok).toBe(false);
    expect((await historySummary(admin.db, orgId)).count).toBe(2);
  });

  it("claim_history_import: admins only, 60 per 24 h", async () => {
    expect((await member.db.rpc("claim_history_import", { p_org_id: orgId })).error?.code).toBe("42501");
    const rows = Array.from({ length: 59 }, () => ({ org_id: orgId }));
    await adminClient().from("history_import_claims").insert(rows);
    expect((await admin.db.rpc("claim_history_import", { p_org_id: orgId })).data).toBe(true);
    expect((await admin.db.rpc("claim_history_import", { p_org_id: orgId })).data).toBe(false);
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
