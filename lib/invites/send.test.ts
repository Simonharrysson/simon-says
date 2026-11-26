import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { inviterNameFor, sendInvites } from "./send";

// sendInvites with a scripted database and a fake mailer (the DB rules run in tests/api/invites.test.ts).
function fakeDb(claims: Record<string, { result: string; send_id?: number; next_at?: string }>) {
  const finished: [number, boolean][] = [];
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn === "claim_invite_send") return { data: claims[args.p_email as string], error: null };
    if (fn === "finish_invite_send") {
      finished.push([args.p_send_id as number, args.p_ok as boolean]);
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
    expect(finished).toEqual([[1, true], [2, false]]);
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

describe("inviterNameFor", () => {
  it("list name, then Google name, never an address", () => {
    expect(inviterNameFor("Anna Berg", { full_name: "Anna B" })).toBe("Anna Berg");
    expect(inviterNameFor(null, { full_name: "Anna B" })).toBe("Anna B");
    expect(inviterNameFor(null, { name: "anna@example.com" })).toBe("En administratör");
    expect(inviterNameFor("  ", undefined)).toBe("En administratör");
  });
});
