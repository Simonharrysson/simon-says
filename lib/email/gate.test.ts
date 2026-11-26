import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Mailer, MailMessage } from "@/lib/mail";
import { checkEmailGate, mayEmail, sendUserMail, sendUserMailDetailed } from "./prefs";

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

  it("no usable recipient is a permanent failure, not a retry", async () => {
    const { db, calls } = fakeDb({ data: true });
    expect(await checkEmailGate({}, "invite", db)).toBe("invalid");
    expect(await sendUserMail(fakeMailer().mailer, { email: "not an address" }, "invite", { subject: "S", text: "T" }, db)).toBe(
      "invalid",
    );
    expect(calls).toEqual([]);
  });

  it("fails closed: no recipient, a database error or a non-true answer sends nothing", async () => {
    expect(await mayEmail({}, "invite", fakeDb({ data: true }).db)).toBe(false);
    expect(await mayEmail({ email: "anna@example.com" }, "invite", fakeDb({ error: { message: "down" } }).db)).toBe(false);
    expect(await mayEmail({ email: "anna@example.com" }, "invite", fakeDb({ data: null }).db)).toBe(false);
  });

  it("sendUserMailDetailed passes an uncertain outcome through; sendUserMail calls it failed", async () => {
    const mailer: Mailer = { send: async () => false, sendWithOutcome: async () => "uncertain" };
    const msg = { subject: "S", text: "T" };
    expect(await sendUserMailDetailed(mailer, { email: "a@example.com" }, "invite", msg, fakeDb({ data: true }).db)).toBe("uncertain");
    expect(await sendUserMail(mailer, { email: "a@example.com" }, "invite", msg, fakeDb({ data: true }).db)).toBe("failed");
    expect(await sendUserMailDetailed(mailer, { email: "a@example.com" }, "invite", msg, fakeDb({ data: false }).db)).toBe("opted_out");
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

// Every mail to a user must pass the gate. The TypeScript checker finds every call of
// Mailer.send / sendWithOutcome (whatever the variable is called) and every string naming api.resend.com; each must
// sit in a function on this list. A new user-facing sender goes through sendUserMail() (or calls
// checkEmailGate() first and is added here with a reason).
const SEND_ALLOWED: Record<string, string> = {
  "lib/alarm.ts#sendDailySummary": "operator mail to ALARM_EMAIL",
  "lib/alarm.ts#checkSpendAlarm": "operator mail to ALARM_EMAIL",
  "lib/meetings/tick.ts#alarmIfNeeded": "operator mail to ALARM_EMAIL",
  "lib/meetings/tick.ts#finishMeeting": "operator mail to ALARM_EMAIL",
  "lib/email/prefs.ts#sendUserMailDetailed": "the gate (sendUserMail calls it)",
};
const RESEND_ALLOWED: Record<string, string> = {
  "lib/mail.ts#resendMailer": "the provider adapter",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The outermost named function around a node (the module-level function a reviewer would look for). */
function enclosingFunction(node: ts.Node): string {
  let name = "(top level)";
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) name = n.name.getText();
    else if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent)) name = n.parent.name.getText();
  }
  return name;
}

describe("mail call sites", () => {
  it("only the operator alarms and the gate send mail; only the adapter talks to Resend", () => {
    const root = process.cwd();
    const files = ["lib", "app", "components", "scripts"]
      .filter((d) => existsSync(join(root, d)))
      .flatMap((d) => sourceFiles(join(root, d)));
    const program = ts.createProgram(files, {
      strict: true,
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      baseUrl: root,
      paths: { "@/*": ["./*"] },
      skipLibCheck: true,
      noEmit: true,
    });
    const checker = program.getTypeChecker();
    const mailFile = program.getSourceFile(join(root, "lib/mail.ts"));
    expect(mailFile).toBeDefined();
    const offenders: string[] = [];
    let sendCalls = 0;
    for (const sf of program.getSourceFiles()) {
      if (!sf.fileName.startsWith(root) || sf.fileName.includes("node_modules")) continue;
      const rel = relative(root, sf.fileName);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && (node.expression.name.text === "send" || node.expression.name.text === "sendWithOutcome")) {
          const decl = checker.getResolvedSignature(node)?.getDeclaration();
          if (decl && decl.getSourceFile() === mailFile) {
            sendCalls++;
            const at = `${rel}#${enclosingFunction(node)}`;
            if (!(at in SEND_ALLOWED)) offenders.push(`Mailer.send in ${at}`);
          }
        }
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)) && /api\.resend\.com/i.test(node.text)) {
          const at = `${rel}#${enclosingFunction(node)}`;
          if (!(at in RESEND_ALLOWED)) offenders.push(`api.resend.com in ${at}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(offenders).toEqual([]);
    // The checker really found them (a broken resolution would pass the test silently).
    expect(sendCalls).toBeGreaterThanOrEqual(Object.keys(SEND_ALLOWED).length);
  }, 120_000);
});
