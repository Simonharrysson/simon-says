import { defaultLocale, type Locale } from "@/lib/i18n/config";
import { translator, type Translator } from "@/lib/i18n/translator";
import { dayMonth, escapeHtml, genitive, weekdayDayMonth, type RenderedEmail } from "@/lib/summaries/email";
import type { SummaryTask } from "@/lib/summaries/content";

// The growth loop's invite mail (0067), and its one reminder. The mock (design A, owner-approved):
// ~/simon-says-private/growth-loop/. The shell is the summary mail's (lib/summaries/email.ts): one
// white card on #fafafa, the serif wordmark, one black button. Real text, no image: the eyebrow,
// the title, one lead line, a counts chip, the recipient's own tasks in full (Vem, När, Klart när),
// the first two decisions in stepped greys ("…och N beslut till"), the button, a footer with a
// reason that is true for this recipient, the unsubscribe link and, under a rule, one upsell line
// (not in the reminder). Pure and escaped; the sender and the tests render through here.

export interface InviteEmailInput {
  locale?: Locale;
  orgName: string;
  /** The starter's full name ("Johanna Lind"); the subject uses the first name. */
  starterName: string;
  /** The calendar title, else null ("Mötet 24 november"). */
  title: string | null;
  startedAt: string;
  /** The recipient's name (a people row or the calendar's display name); null: "Hej!". */
  recipientName: string | null;
  /** The recipient's own open tasks. */
  mine: SummaryTask[];
  /** The meeting's decisions (only the first two are shown). */
  decisions: string[];
  counts: { decisions: number; tasks: number };
  /** The name round named them (the preheader may say "Du nämndes i mötet"). */
  named: boolean;
  /** Why they get it: on the guest list, or at the meeting (named). */
  reason: "guest" | "attended";
  claimHref: string;
  upsellHref: string;
  unsubscribeHref: string;
  reminder?: boolean;
}

export const SHOWN_DECISIONS = 2;

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
const firstName = (n: string | null) => (n ?? "").trim().split(/\s+/)[0] || "";
const tr = (i: InviteEmailInput): Translator => translator(i.locale ?? defaultLocale);
const starterOf = (i: InviteEmailInput) => ((i.locale ?? defaultLocale) === "sv" ? genitive(i.starterName) : `${i.starterName}'s`);

export function inviteTitle(i: Pick<InviteEmailInput, "title" | "startedAt" | "locale">): string {
  const t = translator(i.locale ?? defaultLocale);
  return oneLine(i.title?.trim() || t("emails.meetingInvite.fallbackTitle", { date: dayMonth(i.startedAt, i.locale ?? defaultLocale) }));
}

export function inviteSubject(i: InviteEmailInput): string {
  const t = tr(i);
  return oneLine(
    t(i.reminder ? "emails.meetingInvite.reminderSubject" : "emails.meetingInvite.subject", {
      starter: firstName(i.starterName) || i.starterName,
      title: inviteTitle(i),
    }),
  );
}

/** The inbox preview: personal, and never a mention that didn't happen. */
export function invitePreview(i: InviteEmailInput): string {
  const t = tr(i);
  const n = i.mine.length;
  if (i.reminder) return n ? t("emails.meetingInvite.reminderPreviewMine", { count: n }) : t("emails.meetingInvite.reminderPreview");
  if (n) return t("emails.meetingInvite.previewMine", { count: n });
  if (i.named) return t("emails.meetingInvite.previewNamed");
  return t("emails.meetingInvite.previewCounts", { decisions: i.counts.decisions, tasks: i.counts.tasks });
}

/** The "From" display name: "Johanna via Simon Says". */
export function inviteFromName(i: Pick<InviteEmailInput, "starterName" | "locale">): string {
  return oneLine(translator(i.locale ?? defaultLocale)("emails.meetingInvite.from", { starter: firstName(i.starterName) || i.starterName })).replace(/[<>"]/g, "");
}

function lead(i: InviteEmailInput): string {
  const t = tr(i);
  const first = firstName(i.recipientName);
  const hello = first ? t("emails.meetingInvite.hello", { first }) : t("emails.meetingInvite.helloNoName");
  const day = weekdayDayMonth(i.startedAt, i.locale ?? defaultLocale);
  const starter = firstName(i.starterName) || i.starterName;
  const key = i.reminder ? "emails.meetingInvite.reminderLead" : i.mine.length ? "emails.meetingInvite.leadMine" : "emails.meetingInvite.lead";
  return `${hello} ${t(key, { starter, day })}`;
}

function why(i: InviteEmailInput): string {
  const t = tr(i);
  const base = t(i.reason === "guest" ? "emails.meetingInvite.whyGuest" : "emails.meetingInvite.whyAttended", {
    starterFull: i.starterName,
    title: inviteTitle(i),
    org: i.orgName,
  });
  return `${base} ${t(i.reminder ? "emails.meetingInvite.lastMail" : "emails.meetingInvite.oneReminder")}`;
}

function taskExtras(task: SummaryTask, t: Translator): string[] {
  return [t("emails.meetingInvite.who"), task.due ? t("emails.meetingInvite.due", { due: task.due }) : null, task.doneWhen ? t("emails.meetingInvite.doneWhen", { text: task.doneWhen }) : null].filter(
    (x): x is string => Boolean(x),
  );
}

// ---------------------------------------------------------------------------------------------
// Plain text

export function renderInviteText(i: InviteEmailInput): string {
  const t = tr(i);
  const upper = (s: string) => s.toLocaleUpperCase(i.locale ?? defaultLocale);
  const out: string[] = [t("emails.meetingInvite.eyebrow", { starterOf: starterOf(i), org: i.orgName }), inviteTitle(i), "", lead(i), t("emails.meetingInvite.counts", i.counts), ""];
  if (i.mine.length) {
    out.push(upper(t("emails.meetingInvite.yourTasks", { count: i.mine.length })));
    for (const task of i.mine) out.push(`- ${task.text} (${taskExtras(task, t).join(", ").toLocaleLowerCase(i.locale ?? defaultLocale)})`);
    out.push("");
  }
  if (!i.reminder && i.decisions.length) {
    const shown = i.decisions.slice(0, SHOWN_DECISIONS);
    out.push(upper(t("emails.meetingInvite.decisions")), ...shown.map((d) => `- ${d}`));
    const rest = i.counts.decisions - shown.length;
    if (rest > 0) out.push(t("emails.meetingInvite.moreDecisions", { count: rest }));
    out.push("");
  }
  out.push(t("emails.meetingInvite.buttonText", { url: i.claimHref }), "", "--", "Simon Says", why(i), t("emails.meetingInvite.unsubscribeText", { url: i.unsubscribeHref }));
  if (!i.reminder) out.push("", t("emails.meetingInvite.upsellText", { url: i.upsellHref }));
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------
// HTML

const p = (cls: string, style: string, html: string) => `<p class="${cls}" style="margin:0; font-family:${SANS}; ${style}">${html}</p>`;
const sectionTitle = (text: string) =>
  p("ink-3", "margin:0 0 12px 0; font-size:13px; line-height:20px; font-weight:600; letter-spacing:0.02em; text-transform:uppercase; color:#666666;", escapeHtml(text));

function taskRows(tasks: SummaryTask[], t: Translator): string {
  return tasks
    .map(
      (task) =>
        `<tr><td valign="top" class="ink-3" style="width:26px; padding:0 0 14px 0; font-family:${SANS}; font-size:16px; line-height:24px; color:#666666;">&#9744;</td>` +
        `<td valign="top" style="padding:0 0 14px 0;">` +
        p("ink", "font-size:16px; line-height:24px; font-weight:500; color:#171717;", escapeHtml(task.text)) +
        p("ink-3", "font-size:14px; line-height:21px; color:#666666;", escapeHtml(taskExtras(task, t).join(" · "))) +
        `</td></tr>`,
    )
    .join("");
}

function decisionRows(i: InviteEmailInput, t: Translator): string {
  const tones: [string, string][] = [
    ["ink", "#171717"],
    ["ink-2 fade-2", "#6b6b6b"],
  ];
  const shown = i.decisions.slice(0, SHOWN_DECISIONS);
  const rows = shown.map(
    (d, n) =>
      `<tr><td valign="top" class="${tones[n][0]}" style="width:18px; padding:0 0 8px 0; font-family:${SANS}; font-size:16px; line-height:24px; color:${tones[n][1]};">&ndash;</td>` +
      `<td valign="top" class="${tones[n][0]}" style="padding:0 0 8px 0; font-family:${SANS}; font-size:16px; line-height:24px; color:${tones[n][1]};">${escapeHtml(d)}</td></tr>`,
  );
  const rest = i.counts.decisions - shown.length;
  if (rest > 0) {
    rows.push(
      `<tr><td></td><td class="ink-3 fade-3" style="padding:0 0 4px 0; font-family:${SANS}; font-size:15px; line-height:22px; color:#8f8f8f;">${escapeHtml(t("emails.meetingInvite.moreDecisions", { count: rest }))}</td></tr>`,
    );
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join("")}</table>`;
}

function button(label: string, href: string): string {
  return (
    `<table role="presentation" class="btn-full" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td class="btn-td" bgcolor="#171717" style="background-color:#171717; border-radius:6px;">` +
    `<a class="btn-a" href="${escapeHtml(href)}" target="_blank" style="display:inline-block; padding:14px 24px; font-family:${SANS}; font-size:16px; line-height:20px; font-weight:500; color:#ffffff; text-decoration:none; border-radius:6px;">${escapeHtml(label)}</a>` +
    `</td></tr></table>`
  );
}

const link = (href: string, label: string) => `<a class="link" href="${escapeHtml(href)}" target="_blank" style="color:#0068d6; text-decoration:none;">${escapeHtml(label)}</a>`;

export function renderInviteHtml(i: InviteEmailInput): string {
  const t = tr(i);
  const subject = inviteSubject(i);
  const blocks = [
    `<tr><td style="padding:0 0 20px 0;">${p("ink-3", "font-size:13px; line-height:20px; color:#666666;", escapeHtml(t("emails.meetingInvite.eyebrow", { starterOf: starterOf(i), org: i.orgName })))}</td></tr>`,
    `<tr><td><h1 class="ink h1" style="margin:0 0 16px 0; font-family:${SANS}; font-size:32px; line-height:38px; font-weight:600; letter-spacing:-0.8px; color:#171717;">${escapeHtml(inviteTitle(i))}</h1>` +
      p("ink-2", "margin:0 0 20px 0; font-size:16px; line-height:26px; color:#4d4d4d;", escapeHtml(lead(i))) +
      `</td></tr>`,
    `<tr><td style="padding:0 0 24px 0;"><span class="chip" style="display:inline-block; padding:4px 10px; border-radius:999px; background-color:#f2f2f2; font-family:${SANS}; font-size:13px; line-height:20px; font-weight:500; color:#4d4d4d;">${escapeHtml(t("emails.meetingInvite.counts", i.counts))}</span></td></tr>`,
  ];
  if (i.mine.length) {
    blocks.push(
      `<tr><td style="padding:0 0 28px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
        `<td class="bg-sunk" style="background-color:#f2f2f2; border-radius:8px; padding:20px 20px 6px 20px;">` +
        sectionTitle(t("emails.meetingInvite.yourTasks", { count: i.mine.length })) +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${taskRows(i.mine, t)}</table>` +
        `</td></tr></table></td></tr>`,
    );
  }
  if (!i.reminder && i.decisions.length) {
    blocks.push(`<tr><td style="padding:0 0 24px 0;">${sectionTitle(t("emails.meetingInvite.decisions"))}${decisionRows(i, t)}</td></tr>`);
  }
  blocks.push(
    `<tr><td style="padding-top:4px;">${button(t("emails.meetingInvite.button"), i.claimHref)}</td></tr>`,
    `<tr><td style="padding-top:14px;">${p("ink-3", "font-size:13px; line-height:20px; color:#666666;", escapeHtml(t("emails.meetingInvite.buttonNote")))}</td></tr>`,
  );
  const upsell = i.reminder
    ? ""
    : `
          <tr>
            <td style="padding:20px 4px 0 4px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="rule" style="border-top:1px solid #ebebeb; padding-top:16px;">
              ${p("ink-3", "font-size:13px; line-height:20px; color:#666666;", `${escapeHtml(t("emails.meetingInvite.upsellLead"))} ${link(i.upsellHref, t("emails.meetingInvite.upsellLink"))}`)}
              </td></tr></table>
            </td>
          </tr>`;

  return `<!doctype html>
<html lang="${i.locale ?? defaultLocale}" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(subject)}</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<style>table,td,p,a,h1,span{font-family:Arial,Helvetica,sans-serif !important;}.wm{font-family:Georgia,'Times New Roman',serif !important;}</style>
<![endif]-->
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  body { margin: 0; padding: 0; -webkit-text-size-adjust: 100%; }
  a { text-decoration: none; }
  @media (max-width: 599px) {
    .card-pad { padding: 32px 24px !important; }
    .outer-pad { padding: 16px 12px !important; }
    .h1 { font-size: 26px !important; line-height: 32px !important; }
    .btn-full { width: 100% !important; }
    .btn-full a { display: block !important; text-align: center !important; }
  }
  @media (prefers-color-scheme: dark) {
    .bg-board { background-color: #000000 !important; }
    .bg-card { background-color: #0a0a0a !important; border-color: #2e2e2e !important; }
    .bg-sunk { background-color: #1a1a1a !important; }
    .ink { color: #ededed !important; }
    .ink-2 { color: #bdbdbd !important; }
    .ink-3 { color: #a1a1a1 !important; }
    .rule { border-color: #2e2e2e !important; }
    .btn-td { background-color: #ededed !important; }
    .btn-a { color: #0a0a0a !important; }
    .link { color: #52a8ff !important; }
    .fade-2 { color: #8f8f8f !important; }
    .fade-3 { color: #7a7a7a !important; }
    .chip { background-color: #1a1a1a !important; color: #bdbdbd !important; }
  }
  /* Outlook.com dark mode */
  [data-ogsc] .ink { color: #ededed !important; }
  [data-ogsc] .ink-2 { color: #bdbdbd !important; }
  [data-ogsc] .ink-3 { color: #a1a1a1 !important; }
  [data-ogsc] .link { color: #52a8ff !important; }
  [data-ogsc] .fade-2 { color: #8f8f8f !important; }
  [data-ogsc] .fade-3 { color: #7a7a7a !important; }
  [data-ogsb] .bg-board { background-color: #000000 !important; }
  [data-ogsb] .bg-card { background-color: #0a0a0a !important; }
  [data-ogsb] .bg-sunk { background-color: #1a1a1a !important; }
</style>
</head>
<body class="bg-board" style="margin:0; padding:0; background-color:#fafafa;">
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:#fafafa; opacity:0;">
    ${escapeHtml(invitePreview(i))}
    &#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg-board" style="background-color:#fafafa;">
    <tr>
      <td align="center" class="outer-pad" style="padding:48px 16px;">
        <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; margin:0 auto;">
          <tr>
            <td style="padding:0 4px 20px 4px;">
              <span class="wm ink" style="font-family:'Instrument Serif',Georgia,'Times New Roman',serif; font-size:26px; line-height:30px; font-weight:400; color:#171717; letter-spacing:-0.01em;">Simon Says</span>
            </td>
          </tr>
          <tr>
            <td class="bg-card card-pad" style="background-color:#ffffff; border:1px solid #ebebeb; border-radius:8px; padding:40px 48px 40px 48px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                ${blocks.join("\n                ")}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 4px 0 4px;">
              ${p("ink-3", "font-size:13px; line-height:20px; color:#666666;", `${escapeHtml(why(i))}<br>${link(i.unsubscribeHref, t("emails.meetingInvite.unsubscribe"))}`)}
            </td>
          </tr>${upsell}
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

export function renderInviteEmail(i: InviteEmailInput): RenderedEmail {
  return { subject: inviteSubject(i), preview: invitePreview(i), html: renderInviteHtml(i), text: renderInviteText(i) };
}
