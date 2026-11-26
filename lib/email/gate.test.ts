import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Mailer, MailMessage } from "@/lib/mail";
import { mayEmail, sendUserMail } from "./prefs";

const fakeDb = (answer: { data?: unknown; error?: { message: string } | null }) => {
  const calls: unknown[] = [];
  const db = {
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return { data: answer.data ?? null, error: answer.error ?? null };
    },
  } as unknown as SupabaseClient;
  return { db, calls };
};

const fakeMailer = () => {
  const sent: MailMessage[] = [];
  const mailer: Mailer = { send: async (m) => (sent.push(m), true) };
  return { mailer, sent };
};

describe("the e-mail gate", () => {
  it("asks may_email with the cleaned address and the user id", async () => {
    const { db, calls } = fakeDb({ data: true });
    expect(await mayEmail({ userId: "u1", email: " Anna@Example.com " }, "invite", db)).toBe(true);
    expect(calls).toEqual([
      { fn: "may_email", args: { p_user_id: "u1", p_email: "anna@example.com", p_category: "invite" } },
    ]);
  });

  it("fails closed: no recipient, a database error or a non-true answer sends nothing", async () => {
    expect(await mayEmail({}, "invite", fakeDb({ data: true }).db)).toBe(false);
    expect(await mayEmail({ email: "anna@example.com" }, "invite", fakeDb({ error: { message: "down" } }).db)).toBe(false);
    expect(await mayEmail({ email: "anna@example.com" }, "invite", fakeDb({ data: null }).db)).toBe(false);
  });

  it("sendUserMail sends only when allowed", async () => {
    const yes = fakeMailer();
    const msg = { subject: "S", text: "T" };
    expect(await sendUserMail(yes.mailer, { email: "a@example.com" }, "meeting_summary", msg, fakeDb({ data: true }).db)).toBe("sent");
    expect(yes.sent).toEqual([{ to: "a@example.com", subject: "S", text: "T" }]);
    const no = fakeMailer();
    expect(await sendUserMail(no.mailer, { email: "a@example.com" }, "meeting_summary", msg, fakeDb({ data: false }).db)).toBe(
      "opted_out",
    );
    expect(no.sent).toEqual([]);
    const down = fakeMailer();
    expect(
      await sendUserMail(down.mailer, { email: "a@example.com" }, "invite", msg, fakeDb({ error: { message: "down" } }).db),
    ).toBe("failed");
    expect(down.sent).toEqual([]);
    const broken: Mailer = { send: async () => false };
    expect(await sendUserMail(broken, { email: "a@example.com" }, "invite", msg, fakeDb({ data: true }).db)).toBe("failed");
  });
});

// Every mail to a user must pass the gate. Direct mailer.send() calls are allowed only for the
// operator's own alarms (to ALARM_EMAIL) and inside the gate itself. A new user-facing sender
// goes through sendUserMail() (or calls mayEmail() and is added here with a reason).
const DIRECT_SEND_ALLOWED: Record<string, string> = {
  "lib/alarm.ts": "operator alarms to ALARM_EMAIL",
  "lib/meetings/tick.ts": "operator alarms to ALARM_EMAIL",
  "lib/email/prefs.ts": "the gate",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("mail call sites", () => {
  it("only the operator alarms and the gate call mailer.send directly", () => {
    const offenders = ["lib", "app", "components"]
      .flatMap(sourceFiles)
      .filter((file) => /\bmailer\.send\(/i.test(readFileSync(file, "utf8")))
      .filter((file) => !(file in DIRECT_SEND_ALLOWED));
    expect(offenders).toEqual([]);
  });
});
