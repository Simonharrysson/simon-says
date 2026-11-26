import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { createOrg, joinOrg } from "@/lib/db/orgs";
import type { MailMessage } from "@/lib/mail";

// Invites by e-mail (0038) against the local stack, as real signed-in users. The mailer is a
// fake: nothing leaves the machine. Addresses are example.com / test.local only.
const m = vi.hoisted(() => ({
  db: null as SupabaseClient | null,
  sent: [] as MailMessage[],
  deliver: true,
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => m.db }));
vi.mock("@/lib/origin", () => ({ appOrigin: () => "https://app.test" }));
vi.mock("@/lib/mail", () => ({
  defaultMailer: () => ({
    async send(msg: MailMessage) {
      m.sent.push(msg);
      return m.deliver;
    },
  }),
}));

const route = await import("@/app/api/orgs/[id]/invites/route");
const { sendInvites } = await import("@/lib/invites/send");

const post = (orgId: string, body: unknown) =>
  route.POST(new NextRequest("https://x.test", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), {
    params: Promise.resolve({ id: orgId }),
  });
const get = (orgId: string) => route.GET(new NextRequest("https://x.test"), { params: Promise.resolve({ id: orgId }) });
type Body = { results: { email: string; result: string }[]; invites: { email: string; status: string; recentSends: number }[] };

describe.skipIf(!hasLocalSupabase)("invites route", () => {
  let admin: TestUser;
  let member: TestUser;
  let orgId: string;
  let code: string;

  beforeAll(async () => {
    [admin, member] = await Promise.all([createTestUser("inv-adm"), createTestUser("inv-mem")]);
    const r = await createOrg(admin.db, "Inbjudningsföreningen");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
    code = (await adminClient().from("orgs").select("invite_code").eq("id", orgId).single()).data!.invite_code as string;
    await joinOrg(member.db, code);
  });

  beforeEach(() => {
    m.sent = [];
    m.deliver = true;
  });

  it("members and strangers are refused", async () => {
    m.db = member.db;
    expect((await post(orgId, { emails: "x@example.com" })).status).toBe(403);
    expect((await get(orgId)).status).toBe(403);
    expect(m.sent).toHaveLength(0);
  });

  it("sends one e-mail per new address; skips members, invalid and duplicate input", async () => {
    m.db = admin.db;
    const res = await post(orgId, { emails: `anna@example.com, ANNA@example.com\ninte-en-adress\n${member.email.toUpperCase()}\nbo@example.com` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    const by = Object.fromEntries(body.results.map((r) => [r.email, r.result]));
    expect(by).toEqual({ "inte-en-adress": "invalid", "anna@example.com": "sent", [member.email]: "member", "bo@example.com": "sent" });
    expect(m.sent.map((s) => s.to)).toEqual(["anna@example.com", "bo@example.com"]);
    const mail = m.sent[0];
    expect(mail.subject).toBe("En administratör bjuder in dig till Inbjudningsföreningen på Simon Says");
    expect(mail.replyTo).toBe(admin.email);
    expect(mail.html).toContain(`href="https://app.test/join/${code}"`);
    expect(mail.text).toContain(`https://app.test/join/${code}`);
    expect(body.invites.map((i) => [i.email, i.status]).sort()).toEqual([["anna@example.com", "sent"], ["bo@example.com", "sent"]]);
  });

  it("the inviter's name comes from the förening's list", async () => {
    await adminClient().from("people").insert({ org_id: orgId, name: "Anna Admin", member_user_id: admin.id });
    m.db = admin.db;
    await post(orgId, { emails: "namn@example.com" });
    expect(m.sent[0].subject).toBe("Anna Admin bjuder in dig till Inbjudningsföreningen på Simon Says");
  });

  it("an address already sent today is 'already_invited'; one resend, then the 24 h limit", async () => {
    m.db = admin.db;
    const again = (await (await post(orgId, { emails: "bo@example.com" })).json()) as Body;
    expect(again.results).toEqual([{ email: "bo@example.com", result: "already_invited" }]);
    const resend = (await (await post(orgId, { emails: ["bo@example.com"], resend: true })).json()) as Body;
    expect(resend.results).toEqual([{ email: "bo@example.com", result: "sent" }]);
    const third = (await (await post(orgId, { emails: ["bo@example.com"], resend: true })).json()) as Body;
    expect(third.results[0].result).toBe("resend_limit");
    expect(m.sent.map((s) => s.to)).toEqual(["bo@example.com"]);
  });

  it("a failed send is recorded and can be tried again right away", async () => {
    m.db = admin.db;
    m.deliver = false;
    const first = (await (await post(orgId, { emails: "cecilia@example.com" })).json()) as Body;
    expect(first.results).toEqual([{ email: "cecilia@example.com", result: "failed" }]);
    expect(first.invites.find((i) => i.email === "cecilia@example.com")?.status).toBe("failed");
    m.deliver = true;
    const retry = (await (await post(orgId, { emails: ["cecilia@example.com"], resend: true })).json()) as Body;
    expect(retry.results).toEqual([{ email: "cecilia@example.com", result: "sent" }]);
  });

  it("joining with the invited (confirmed) address marks the invite accepted", async () => {
    const invitee = await createTestUser("inv-new");
    m.db = admin.db;
    await post(orgId, { emails: invitee.email.toUpperCase() });
    await joinOrg(invitee.db, code);
    const list = (await (await get(orgId)).json()) as Body;
    expect(list.invites.find((i) => i.email === invitee.email)?.status).toBe("accepted");
    // A member now: inviting again sends nothing.
    const again = (await (await post(orgId, { emails: invitee.email, resend: true })).json()) as Body;
    expect(again.results[0].result).toBe("member");
  });

  it("the förening's daily limit holds (counted in the database)", async () => {
    const r = await createOrg(admin.db, "Gränsföreningen");
    if (!r.ok) throw new Error("org");
    const mailer = { send: vi.fn(async () => true) };
    const input = { orgId: r.id, userId: admin.id, inviterName: "A", inviterEmail: null, orgName: "G", inviteUrl: "https://app.test/join/x", resend: false };
    const emails = Array.from({ length: 50 }, (_, i) => `limit${i}@example.com`);
    const first = await sendInvites({ ...input, emails }, { db: adminClient(), mailer, gapMs: 0 });
    expect(first.every((x) => x.result === "sent")).toBe(true);
    const over = await sendInvites({ ...input, emails: ["one-more@example.com"] }, { db: adminClient(), mailer, gapMs: 0 });
    expect(over).toEqual([{ email: "one-more@example.com", result: "org_limit" }]);
    expect(mailer.send).toHaveBeenCalledTimes(50);
  });

  it("the tables are not readable or writable by signed-in users", async () => {
    const { data } = await admin.db.from("org_invites").select("email");
    expect(data ?? []).toEqual([]);
    const { error } = await admin.db.rpc("claim_invite_send", { p_org_id: orgId, p_user_id: admin.id, p_email: "z@example.com", p_resend: false, p_org_limit: 50, p_user_limit: 200, p_address_limit: 2 });
    expect(error).not.toBeNull();
  });
});
