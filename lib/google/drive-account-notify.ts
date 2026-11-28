import "server-only";
import { orgMemberList } from "@/lib/db/members";
import { loadEmailPrefs } from "@/lib/email/prefs";
import { defaultMailer, type Mailer } from "@/lib/mail";
import { appOrigin } from "@/lib/origin";
import { supabaseAdmin } from "@/lib/supabase/admin";

// An admin replaced the förening's Drive account another admin connected (0070): the förening's
// other admins get a short mail (the folder card also says it for 30 days). A security notice about
// where the förening's documents go, so not one of the optional categories; "Inga mejl alls" is
// still respected. Never the addresses in logs.

export interface ReplacedNotice {
  orgId: string;
  orgName: string;
  /** The admin who replaced it (gets no mail). */
  byUserId: string;
  byName: string;
  oldEmail: string;
  newEmail: string;
}

export function replacedMail(n: ReplacedNotice, link: string): { subject: string; text: string } {
  return {
    subject: `${n.orgName}: Drive-kontot byttes`,
    text: [
      `${n.byName} bytte Google-kontot som ${n.orgName}s mötesdokument skrivs i, från ${n.oldEmail} till ${n.newEmail}.`,
      "",
      "Nya dokument hamnar nu i det nya kontot. Var det inte meningen kan du som admin byta tillbaka under Inställningar › Möten:",
      link,
      "",
      `${n.byName} switched the Google account ${n.orgName}'s meeting documents are written to, from ${n.oldEmail} to ${n.newEmail}. If that wasn't intended, an admin can switch back under Settings › Meetings.`,
    ].join("\n"),
  };
}

/** Mails the förening's other admins. Best effort: returns how many got it. */
export async function notifyDriveAccountReplaced(n: ReplacedNotice, mailer: Mailer = defaultMailer()): Promise<number> {
  const admins = (await orgMemberList(n.orgId)).filter((m) => m.role === "admin" && m.userId !== n.byUserId && m.email);
  const link = `${appOrigin()}/orgs/${n.orgId}?flik=installningar&del=moten`;
  const { subject, text } = replacedMail(n, link);
  let sent = 0;
  for (const a of admins) {
    const prefs = await loadEmailPrefs({ userId: a.userId, email: a.email }, supabaseAdmin());
    if (prefs?.allOff) continue;
    if (await mailer.send({ to: a.email, subject, text, idempotencyKey: `drive-replaced-${n.orgId}-${a.userId}-${n.newEmail}` })) sent++;
  }
  console.info(`org drive ${n.orgId}: replaced by ${n.byUserId}; ${sent} of ${admins.length} admins mailed`);
  return sent;
}
