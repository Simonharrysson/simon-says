import { stockholmDateTime } from "@/lib/calendar/events";
import { dueDayLabel } from "@/lib/home/tasks";
import { defaultLocale, type Locale } from "@/lib/i18n/config";
import { translator, type Translator } from "@/lib/i18n/translator";
import { dayMonth, escapeHtml, type RenderedEmail } from "@/lib/summaries/email";
import type { BriefContent, BriefDecision, BriefTask } from "./content";

// The Inför möten mail (0059), in the summary mail's design ("Calm Geist": one white card on
// #fafafa, the serif wordmark, one black button, grey footer; inline light styles, the <style>
// block only adds dark mode and phone padding). Short on purpose: four small sections at most.
// Pure; every text is escaped. Only stored facts: the decisions and tasks as written, each tied to
// the meeting it came from (date + link).

export interface BriefEmailInput {
  locale?: Locale;
  recipientName: string | null;
  /** The calendar event's title. */
  eventTitle: string;
  /** The event's start (ISO). */
  startsAt: string;
  /** Who you meet: the förening, the company or the customer. */
  groupName: string;
  /** The space (förening or company) the mail is sent for, for the footer. */
  spaceName: string;
  content: BriefContent;
  decisions: BriefDecision[];
  /** "Avsluta": the address's /mejl page, meeting_brief preselected. */
  unsubscribeHref: string;
}

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
const tr = (i: BriefEmailInput): Translator => translator(i.locale ?? defaultLocale);

/** "14.00" in Swedish, "14:00" in English (Stockholm time). */
export function briefTime(iso: string, locale: Locale = defaultLocale): string {
  const { time } = stockholmDateTime(iso);
  return locale === "sv" ? time.replace(":", ".") : time;
}

export function briefSubject(i: Pick<BriefEmailInput, "eventTitle" | "groupName" | "startsAt" | "locale">): string {
  const title = oneLine(i.eventTitle) || oneLine(i.groupName);
  return oneLine(tr(i as BriefEmailInput)("emails.brief.subject", { title, time: briefTime(i.startsAt, i.locale) }));
}

function taskWords(t: BriefTask, i: BriefEmailInput): { who: string; when: string } {
  const x = tr(i);
  const locale = i.locale ?? defaultLocale;
  const who = t.mine ? x("emails.brief.you") : (t.owner ?? x("emails.brief.unassigned"));
  const day = t.dueDate ? x("emails.brief.dueOn", { day: dueDayLabel(t.dueDate, locale) }) : t.due;
  const when = [day, t.overdue ? x("emails.brief.overdue") : null].filter(Boolean).join(", ");
  return { who, when };
}

function heading(i: BriefEmailInput): { title: string; lead: string } {
  const x = tr(i);
  const time = briefTime(i.startsAt, i.locale);
  const first = i.recipientName?.trim().split(/\s+/)[0];
  const group = oneLine(i.groupName);
  return {
    title: x("emails.brief.title", { title: oneLine(i.eventTitle) || group }),
    lead: first ? x("emails.brief.lead", { first, group, time }) : x("emails.brief.leadNoName", { group, time }),
  };
}

function previewText(i: BriefEmailInput): string {
  const x = tr(i);
  const last = i.content.last;
  return last ? x("emails.brief.preview", { date: dayMonth(last.at, i.locale) }) : x("emails.brief.previewNoLast");
}

/** "24 november: Budget och prova-på-kväll" (the meeting's title, else who you met). */
const lastTitle = (i: BriefEmailInput) =>
  tr(i)("emails.brief.lastLine", { date: dayMonth(i.content.last!.at, i.locale), title: oneLine(i.content.last!.title ?? i.groupName) });

/** Where the button goes: the last meeting's page, else the prepared agenda. */
function buttonHref(i: BriefEmailInput): { href: string; label: string; text: string } | null {
  const x = tr(i);
  if (i.content.last) return { href: i.content.last.href, label: x("emails.brief.button"), text: x("emails.brief.buttonText", { url: i.content.last.href }) };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Plain text

export function renderBriefText(i: BriefEmailInput): string {
  const x = tr(i);
  const upper = (s: string) => s.toLocaleUpperCase(i.locale ?? defaultLocale);
  const { title, lead } = heading(i);
  const c = i.content;
  const out: string[] = [title, "", lead, ""];
  if (c.last) out.push(upper(x("emails.brief.last")), lastTitle(i), c.last.href, "");
  if (i.decisions.length) {
    out.push(upper(x("emails.brief.decisions")), ...i.decisions.map((d) => `- ${d.text} (${x("emails.brief.from", { date: dayMonth(d.meeting.at, i.locale) })}: ${d.meeting.href})`), "");
  }
  const task = (t: BriefTask) => {
    const w = taskWords(t, i);
    return `- ${w.who}: ${t.text}${w.when ? ` (${w.when})` : ""}`;
  };
  if (c.promised.length) out.push(upper(x("emails.brief.promised")), ...c.promised.map(task), "");
  if (c.open.length) out.push(upper(x("emails.brief.open")), ...c.open.map(task), ...(c.moreOpen ? [`- ${x("emails.brief.more", { count: c.moreOpen })}`] : []), "");
  if (c.agenda) out.push(upper(x("emails.brief.agenda")), ...c.agenda.labels.map((l) => `- ${l}`), `${x("emails.brief.openAgenda")}: ${c.agenda.href}`, "");
  const button = buttonHref(i);
  if (button) out.push(button.text);
  out.push("", "--", "Simon Says", x("emails.brief.why", { space: oneLine(i.spaceName) }), x("emails.brief.unsubscribeText", { url: i.unsubscribeHref }));
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------
// HTML

const sectionTitle = (title: string) =>
  `<p class="ink-3" style="margin:0 0 10px 0; font-family:${SANS}; font-size:13px; line-height:20px; font-weight:600; letter-spacing:0.02em; text-transform:uppercase; color:#666666;">${escapeHtml(title)}</p>`;

function list(rows: string[], more: string | null): string {
  const tr = rows.map(
    (r) =>
      `<tr><td valign="top" class="ink-3" style="width:18px; padding:0 0 8px 0; font-family:${SANS}; font-size:16px; line-height:24px; color:#666666;">&ndash;</td>` +
      `<td valign="top" class="ink" style="padding:0 0 8px 0; font-family:${SANS}; font-size:16px; line-height:24px; color:#171717;">${r}</td></tr>`,
  );
  if (more) tr.push(`<tr><td></td><td class="ink-3" style="padding:0 0 8px 0; font-family:${SANS}; font-size:14px; line-height:22px; color:#666666;">${escapeHtml(more)}</td></tr>`);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${tr.join("")}</table>`;
}

const link = (href: string, text: string) => `<a class="link" href="${escapeHtml(href)}" target="_blank" style="color:#0068d6; text-decoration:none;">${escapeHtml(text)}</a>`;
const grey = (s: string) => `<span class="ink-3" style="color:#666666;">${s}</span>`;
const block = (inner: string) => `<tr><td style="padding:0 0 20px 0;">${inner}</td></tr>`;

export function renderBriefHtml(i: BriefEmailInput): string {
  const x = tr(i);
  const { title, lead } = heading(i);
  const c = i.content;
  const blocks: string[] = [];
  if (c.last) blocks.push(block(sectionTitle(x("emails.brief.last")) + `<p class="ink" style="margin:0; font-family:${SANS}; font-size:16px; line-height:24px; color:#171717;">${link(c.last.href, lastTitle(i))}</p>`));
  if (i.decisions.length) {
    blocks.push(
      block(
        sectionTitle(x("emails.brief.decisions")) +
          list(
            i.decisions.map((d) => `${escapeHtml(d.text)} ${grey(`&middot; ${link(d.meeting.href, dayMonth(d.meeting.at, i.locale))}`)}`),
            null,
          ),
      ),
    );
  }
  const task = (t: BriefTask) => {
    const w = taskWords(t, i);
    return `<span style="font-weight:600;">${escapeHtml(w.who)}:</span> ${escapeHtml(t.text)}${w.when ? ` ${grey(escapeHtml(`(${w.when})`))}` : ""}`;
  };
  // Promised first, on the sunk background: it is what the meeting will ask about.
  if (c.promised.length) {
    blocks.push(
      `<tr><td style="padding:0 0 24px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
        `<td class="bg-sunk" style="background-color:#f2f2f2; border-radius:8px; padding:20px 20px 12px 20px;">` +
        sectionTitle(x("emails.brief.promised")) +
        list(c.promised.map(task), null) +
        `</td></tr></table></td></tr>`,
    );
  }
  if (c.open.length) blocks.push(block(sectionTitle(x("emails.brief.open")) + list(c.open.map(task), c.moreOpen ? x("emails.brief.more", { count: c.moreOpen }) : null)));
  if (c.agenda) {
    blocks.push(block(sectionTitle(x("emails.brief.agenda")) + list(c.agenda.labels.map(escapeHtml), null) + `<p style="margin:4px 0 0 0; font-family:${SANS}; font-size:14px; line-height:22px;">${link(c.agenda.href, x("emails.brief.openAgenda"))}</p>`));
  }
  const button = buttonHref(i);
  const subject = briefSubject(i);

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
    .btn-td { background-color: #ededed !important; }
    .btn-a { color: #0a0a0a !important; }
    .link { color: #52a8ff !important; }
  }
  [data-ogsc] .ink { color: #ededed !important; }
  [data-ogsc] .ink-2 { color: #bdbdbd !important; }
  [data-ogsc] .ink-3 { color: #a1a1a1 !important; }
  [data-ogsc] .link { color: #52a8ff !important; }
  [data-ogsb] .bg-board { background-color: #000000 !important; }
  [data-ogsb] .bg-card { background-color: #0a0a0a !important; }
  [data-ogsb] .bg-sunk { background-color: #1a1a1a !important; }
</style>
</head>
<body class="bg-board" style="margin:0; padding:0; background-color:#fafafa;">
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:#fafafa; opacity:0;">
    ${escapeHtml(previewText(i))}
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
            <td class="bg-card card-pad" style="background-color:#ffffff; border:1px solid #ebebeb; border-radius:8px; padding:48px 48px 40px 48px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <h1 class="ink h1" style="margin:0 0 16px 0; font-family:${SANS}; font-size:32px; line-height:38px; font-weight:600; letter-spacing:-0.8px; color:#171717;">${escapeHtml(title)}</h1>
                    <p class="ink-2" style="margin:0 0 32px 0; font-family:${SANS}; font-size:16px; line-height:26px; color:#4d4d4d;">${escapeHtml(lead)}</p>
                  </td>
                </tr>
                ${blocks.join("\n                ")}${
                  button
                    ? `
                <tr>
                  <td style="padding-top:8px;">
                    <table role="presentation" class="btn-full" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td class="btn-td" bgcolor="#171717" style="background-color:#171717; border-radius:6px;">
                          <a class="btn-a" href="${escapeHtml(button.href)}" target="_blank" style="display:inline-block; padding:14px 24px; font-family:${SANS}; font-size:16px; line-height:20px; font-weight:500; color:#ffffff; text-decoration:none; border-radius:6px;">${escapeHtml(button.label)}</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>`
                    : ""
                }
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 4px 0 4px;">
              <p class="ink-3" style="margin:0; font-family:${SANS}; font-size:13px; line-height:20px; color:#666666;">${escapeHtml(x("emails.brief.why", { space: oneLine(i.spaceName) }))}<br>${link(i.unsubscribeHref, x("emails.brief.unsubscribe"))}</p>
            </td>
          </tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

export function renderBriefEmail(i: BriefEmailInput): RenderedEmail {
  return { subject: briefSubject(i), preview: previewText(i), html: renderBriefHtml(i), text: renderBriefText(i) };
}
