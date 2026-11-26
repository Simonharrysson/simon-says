import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { inviterNameFor, sendInvites } from "./send";

// sendInvites with a scripted database and a fake mailer (the DB rules run in tests/api/invites.test.ts).
function fakeDb(claims: Record<string, { result: string; send_id?: number; next_at?: string }>, optedOut: string[] = []) {
  const finished: [number, string][] = [];
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn === "may_email") return { data: !optedOut.includes(args.p_email as string), error: null };
    if (fn === "claim_invite_send") return { data: claims[args.p_email as string], error: null };
    if (fn === "finish_invite_send") {
      finished.push([args.p_send_id as number, args.p_outcome as string]);
      return { data: null, error: null };
    }
    throw new Error(fn);
  });
  return { db: { rpc } as unknown as SupabaseClient, finished };
}

const input = { orgId: "o", userId: "u", inviterName: "Anna Berg", inviterEmail: "anna@example.com", orgName: "Föreningen", inviteUrl: "https://app.test/join/abc", resend: false };

describe("sendInvites", () => {
  it("sends only claimed addresses, with Reply-To, and records each outcome", async () => {
    const { db, finished } = fakeDb({
      "a@example.com": { result: "ok", send_id: 1 },
      "b@example.com": { result: "member" },
      "c@example.com": { result: "ok", send_id: 2 },
      "d@example.com": { result: "resend_limit", next_at: "2026-11-27T10:00:00Z" },
    });
    const mailer = { send: vi.fn(async (msg: { to: string }) => msg.to !== "c@example.com") };
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const res = await sendInvites({ ...input, emails: ["a@example.com", "b@example.com", "c@example.com", "d@example.com"] }, { db, mailer, gapMs: 0 });
    expect(res).toEqual([
      { email: "a@example.com", result: "sent" },
      { email: "b@example.com", result: "member" },
      { email: "c@example.com", result: "failed" },
      { email: "d@example.com", result: "resend_limit", nextAt: "2026-11-27T10:00:00Z" },
    ]);
    expect(finished.sort()).toEqual([[1, "sent"], [2, "failed"]]);
    expect(mailer.send).toHaveBeenCalledTimes(2);
    expect(mailer.send.mock.calls[0][0]).toMatchObject({ to: "a@example.com", replyTo: "anna@example.com", subject: "Anna Berg bjuder in dig till Föreningen på Simon Says" });
    // No address in the log line.
    expect(log.mock.calls.flat().join(" ")).not.toMatch(/@/);
    log.mockRestore();
  });

  it("a refused claim (not an admin) stops everything", async () => {
    const { db } = fakeDb({ "a@example.com": { result: "forbidden" } });
    const mailer = { send: vi.fn(async () => true) };
    await expect(sendInvites({ ...input, emails: ["a@example.com"] }, { db, mailer, gapMs: 0 })).rejects.toMatchObject({ code: "42501" });
    expect(mailer.send).not.toHaveBeenCalled();
  });
});

describe("sendInvites: outcomes, keys, time and names", () => {
  it("passes the claim's Idempotency-Key and records an uncertain send as such", async () => {
    const { db, finished } = fakeDb({ "a@example.com": { result: "ok", send_id: 7, idem_key: "invite-x-0" } as never });
    const mailer = { send: vi.fn(async () => true), sendWithOutcome: vi.fn(async (_m: { idempotencyKey?: string }) => "uncertain" as const) };
    vi.spyOn(console, "info").mockImplementation(() => {});
    const res = await sendInvites({ ...input, emails: ["a@example.com"] }, { db, mailer, gapMs: 0 });
    expect(res).toEqual([{ email: "a@example.com", result: "uncertain" }]);
    expect(mailer.sendWithOutcome.mock.calls[0][0]).toMatchObject({ idempotencyKey: "invite-x-0" });
    expect(mailer.send).not.toHaveBeenCalled();
    expect(finished).toEqual([[7, "uncertain"]]);
  });

  it("stops starting sends at the deadline: the rest are not_sent, in order", async () => {
    const claims = Object.fromEntries(["a", "b", "c"].map((x, i) => [`${x}@example.com`, { result: "ok", send_id: i + 1 }]));
    const { db } = fakeDb(claims);
    const mailer = { send: vi.fn(async () => true) };
    const res = await sendInvites({ ...input, emails: ["a@example.com", "b@example.com", "c@example.com"] }, { db, mailer, gapMs: 0, deadlineMs: -1 });
    expect(res.map((r) => r.result)).toEqual(["not_sent", "not_sent", "not_sent"]);
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("refuses names that look like links before anything is claimed", async () => {
    const { db } = fakeDb({});
    const mailer = { send: vi.fn(async () => true) };
    await expect(sendInvites({ ...input, orgName: "Konto låst – verifiera på bank-login.se", emails: ["a@example.com"] }, { db, mailer })).rejects.toMatchObject({ code: "name_link" });
    expect(db.rpc).not.toHaveBeenCalled();
  });
});

describe("sendInvites and the mail-settings gate (0039)", () => {
  it("an address that said no is 'opted_out' before any claim; others get their own settings link and List-Unsubscribe", async () => {
    const { db } = fakeDb({ "ja@example.com": { result: "ok", send_id: 1 } }, ["nej@example.com"]);
    const mailer = { send: vi.fn(async (_m: { to: string; text: string; headers?: Record<string, string> }) => true) };
    vi.spyOn(console, "info").mockImplementation(() => {});
    const links = { prefsUrl: (e: string) => `https://app.test/mejl?for=${e}`, headers: (e: string) => ({ "List-Unsubscribe": `<https://app.test/u?${e}>` }) };
    const res = await sendInvites({ ...input, emails: ["nej@example.com", "ja@example.com"] }, { db, mailer, gapMs: 0, links });
    expect(res).toEqual([{ email: "nej@example.com", result: "opted_out" }, { email: "ja@example.com", result: "sent" }]);
    const claimed = (db.rpc as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "claim_invite_send").map((c) => (c[1] as { p_email: string }).p_email);
    expect(claimed).toEqual(["ja@example.com"]);
    expect(mailer.send).toHaveBeenCalledTimes(1);
    const sent = mailer.send.mock.calls[0][0];
    expect(sent.to).toBe("ja@example.com");
    expect(sent.text).toContain("https://app.test/mejl?for=ja@example.com");
    expect(sent.headers).toEqual({ "List-Unsubscribe": "<https://app.test/u?ja@example.com>" });
  });
});

describe("inviterNameFor", () => {
  it("list name, then Google name, never an address", () => {
    expect(inviterNameFor("Anna Berg", { full_name: "Anna B" })).toBe("Anna Berg");
    expect(inviterNameFor(null, { full_name: "Anna B" })).toBe("Anna B");
    expect(inviterNameFor(null, { name: "anna@example.com" })).toBe("En administratör");
    expect(inviterNameFor("  ", undefined)).toBe("En administratör");
  });
});
