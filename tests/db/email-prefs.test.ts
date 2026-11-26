import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { testEnv } from "@/test/env";
import { adminClient, anonClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { loadEmailPrefs, mayEmail, saveAddressEmailPrefs, saveMyEmailPrefs, sendUserMail } from "@/lib/email/prefs";
import type { Mailer, MailMessage } from "@/lib/mail";

// 0039: e-mail preferences per account and per address, and the may_email gate.

const fakeMailer = () => {
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    async send(m) {
      sent.push(m);
      return true;
    },
  };
  return { mailer, sent };
};

describe.skipIf(!hasLocalSupabase)("e-mail preferences (0039)", () => {
  let a: TestUser;
  let b: TestUser;

  beforeAll(async () => {
    Object.assign(process.env, testEnv, {
      SUPABASE_URL: process.env.LOCAL_SUPABASE_API_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY,
    });
    [a, b] = await Promise.all([createTestUser("prefa"), createTestUser("prefb")]);
  });

  it("defaults to everything on, for accounts and unknown addresses", async () => {
    expect(await mayEmail({ userId: a.id }, "meeting_summary")).toBe(true);
    expect(await mayEmail({ email: `ny-${randomUUID()}@test.local` }, "invite")).toBe(true);
    expect(await loadEmailPrefs({ userId: a.id })).toEqual({ allOff: false, off: [] });
  });

  it("a user turns one category off: blocked by id and by address, the other still on", async () => {
    expect(await saveMyEmailPrefs(a.db, { allOff: false, off: ["meeting_summary"] })).toBe(true);
    expect(await mayEmail({ userId: a.id }, "meeting_summary")).toBe(false);
    expect(await mayEmail({ email: a.email.toUpperCase() }, "meeting_summary")).toBe(false);
    expect(await mayEmail({ userId: a.id }, "invite")).toBe(true);
    const { data } = await a.db.from("email_preferences").select("all_off, off_categories");
    expect(data).toEqual([{ all_off: false, off_categories: ["meeting_summary"] }]);
  });

  it("Inga mejl alls blocks every category and keeps the per-category choices", async () => {
    expect(await saveMyEmailPrefs(a.db, { allOff: true, off: ["meeting_summary"] })).toBe(true);
    expect(await mayEmail({ userId: a.id }, "invite")).toBe(false);
    expect(await loadEmailPrefs({ userId: a.id })).toEqual({ allOff: true, off: ["meeting_summary"] });
    expect(await saveMyEmailPrefs(a.db, { allOff: false, off: [] })).toBe(true);
    expect(await mayEmail({ userId: a.id }, "invite")).toBe(true);
  });

  it("RLS: a user sees only their own row and cannot write rows directly", async () => {
    await saveMyEmailPrefs(b.db, { allOff: false, off: ["invite"] });
    const { data } = await a.db.from("email_preferences").select("user_id");
    expect(data?.map((r) => r.user_id)).toEqual([a.id]);
    const { error: ins } = await a.db.from("email_preferences").insert({ user_id: b.id, all_off: true });
    expect(ins).not.toBeNull();
    const { error: upd } = await a.db.from("email_preferences").update({ all_off: true }).eq("user_id", b.id);
    expect(upd).not.toBeNull();
    expect(await mayEmail({ userId: b.id }, "meeting_summary")).toBe(true);
  });

  it("address rows, the gate and the writers are server-only", async () => {
    const { error: sel } = await a.db.from("email_address_preferences").select("email").limit(1);
    expect(sel).not.toBeNull();
    const { error: gate } = await a.db.rpc("may_email", { p_user_id: b.id, p_email: null, p_category: "invite" });
    expect(gate).not.toBeNull();
    const { error: addr } = await a.db.rpc("set_email_preferences_for_address", {
      p_email: b.email,
      p_all_off: true,
      p_off_categories: [],
    });
    expect(addr).not.toBeNull();
    const { error: anonSel } = await anonClient().from("email_preferences").select("user_id").limit(1);
    expect(anonSel).not.toBeNull();
    const { error: anonSet } = await anonClient().rpc("set_my_email_preferences", { p_all_off: true, p_off_categories: [] });
    expect(anonSet).not.toBeNull();
  });

  it("refuses unknown categories", async () => {
    const { error } = await a.db.rpc("set_my_email_preferences", { p_all_off: false, p_off_categories: ["spam"] });
    expect(error).not.toBeNull();
  });

  it("a never-e-mail-me from an address without an account blocks even a first invite", async () => {
    const email = `nej-${randomUUID()}@test.local`;
    const { mailer, sent } = fakeMailer();
    expect(await sendUserMail(mailer, { email }, "invite", { subject: "Inbjudan", text: "..." })).toBe("sent");
    expect(await saveAddressEmailPrefs(email, { allOff: true, off: [] })).toBe(true);
    expect(await sendUserMail(mailer, { email: email.toUpperCase() }, "invite", { subject: "Inbjudan", text: "..." })).toBe(
      "opted_out",
    );
    expect(sent.length).toBe(1);
    const { data } = await adminClient().from("email_address_preferences").select("all_off").eq("email", email);
    expect(data).toEqual([{ all_off: true }]);
  });

  it("the link (address) and the account stay in step both ways", async () => {
    const c = await createTestUser("prefc");
    // Said no by link before ever opening settings: the account is blocked too and shows it.
    expect(await saveAddressEmailPrefs(c.email, { allOff: false, off: ["meeting_summary"] })).toBe(true);
    expect(await mayEmail({ userId: c.id }, "meeting_summary")).toBe(false);
    expect(await loadEmailPrefs({ userId: c.id })).toEqual({ allOff: false, off: ["meeting_summary"] });
    // Turning it back on in settings turns it on for the address too.
    expect(await saveMyEmailPrefs(c.db, { allOff: false, off: [] })).toBe(true);
    expect(await mayEmail({ email: c.email }, "meeting_summary")).toBe(true);
    // And a link change updates an existing account row.
    expect(await saveAddressEmailPrefs(c.email, { allOff: true, off: [] })).toBe(true);
    const { data } = await c.db.from("email_preferences").select("all_off");
    expect(data).toEqual([{ all_off: true }]);
  });
});
