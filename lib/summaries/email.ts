import { defaultLocale, intlTag, type Locale } from "@/lib/i18n/config";
import { translator, type Translator } from "@/lib/i18n/translator";
import type { SummaryContent, SummaryTask } from "./content";

// The summary e-mail, in the recipient's language (Swedish unless their account chose English;
// the meeting's own decisions and tasks stay as written in the Doc), in the invite e-mail's design A ("Calm Geist", branch
// invite-email, emails/invite/a.html): one white card on #fafafa, the serif wordmark, one black
// button, footer in grey. Inline styles carry the light design; the <style> block only adds dark
// mode and phone padding (clients that drop it still get a working e-mail). Pure: the sender, the
// /design gallery and the screenshot script all render through here. Every text is escaped.

export interface SummaryEmailInput {
  orgName: string;
  /** When the meeting started (the date in the subject and heading, Stockholm time). */
  startedAt: string;
  recipientName: string;
  /** Not at the meeting: "Du missade mötet …"; else neutral. */
  missed: boolean;
  content: SummaryContent;
  /** "Öppna protokollet": the Doc, or the meeting's row on the förening page. */
  buttonHref: string;
  /** One grey line under the button about access (null: none). */
  accessNote: string | null;
  /** Admins: link to Inställningar → Sammanfattning efter mötet. */
  settingsHref: string | null;
  /** "Avsluta prenumeration": the address's /mejl page (0039), meeting_summary preselected. */
  unsubscribeHref: string;
  /** The recipient's language; Swedish when unknown. */
  locale?: Locale;
}

export interface RenderedEmail {
  subject: string;
  /** Preheader: the inbox's one-line preview. */
  preview: string;
  html: string;
  text: string;
}

const TZ = "Europe/Stockholm";

/** "24 november" (Stockholm). */
export function dayMonth(iso: string, locale: Locale = defaultLocale): string {
  return new Intl.DateTimeFormat(intlTag(locale), { day: "numeric", month: "long", timeZone: TZ }).format(new Date(iso));
}

/** "tisdag 24 november" (Stockholm). */
export function weekdayDayMonth(iso: string, locale: Locale = defaultLocale): string {
  return new Intl.DateTimeFormat(intlTag(locale), { weekday: "long", day: "numeric", month: "long", timeZone: TZ }).format(new Date(iso));
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Subject and header lines: no line breaks. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export function summarySubject(orgName: string, startedAt: string, locale: Locale = defaultLocale): string {
  return oneLine(translator(locale)("emails.summary.subject", { org: orgName, date: dayMonth(startedAt, locale) }));
}

const tr = (i: SummaryEmailInput): Translator => translator(i.locale ?? defaultLocale);
/** "Exempelföreningens möte" in Swedish, "the Exempelföreningen meeting" in English. */
const orgOf = (i: SummaryEmailInput) => ((i.locale ?? defaultLocale) === "sv" ? genitive(i.orgName) : i.orgName);

function taskLine(t: SummaryTask, withOwner: boolean): string {
  const owner = withOwner && t.owner ? `${t.owner}: ` : "";
  const due = t.due ? ` (${t.due})` : "";
  return `${owner}${t.text}${due}`;
}

function previewText(i: SummaryEmailInput): string {
  const t = tr(i);
  const c = i.content;
  const parts: string[] = [];
  if (c.decisions.length) parts.push(t("emails.summary.previewDecisions", { count: c.decisions.length + c.more.decisions }));
  const mine = c.tasks.filter((x) => x.mine).length;
  if (mine) parts.push(t("emails.summary.previewMine", { count: mine }));
  else if (c.tasks.length) parts.push(t("emails.summary.previewTasks", { count: c.tasks.length + c.more.tasks }));
  return parts.length ? t("emails.summary.previewFrom", { parts: parts.join(t("emails.summary.previewJoin")) }) : t("emails.summary.previewNone");
}

/** Swedish genitive: "Exempelföreningen" → "Exempelföreningens"; a name ending in s, x or z stays as it is. */
export function genitive(name: string): string {
  const t = name.trim();
  return /[sxz]$/i.test(t) ? t : `${t}s`;
}

function heading(i: SummaryEmailInput): { title: string; lead: string } {
  const t = tr(i);
  const locale = i.locale ?? defaultLocale;
  const day = weekdayDayMonth(i.startedAt, locale);
  const date = dayMonth(i.startedAt, locale);
  const first = i.recipientName.trim().split(/\s+/)[0] || i.recipientName;
  return i.missed
    ? { title: t("emails.summary.missedTitle", { date }), lead: t("emails.summary.missedLead", { first, orgOf: orgOf(i), day }) }
    : { title: t("emails.summary.title", { date }), lead: t("emails.summary.lead", { first, orgOf: orgOf(i), day }) };
}

// ---------------------------------------------------------------------------------------------
// Plain text

export function renderSummaryText(i: SummaryEmailInput): string {
  const t = tr(i);
  const upper = (s: string) => s.toLocaleUpperCase(i.locale ?? defaultLocale);
  const { title, lead } = heading(i);
  const c = i.content;
  const out: string[] = [title, "", lead, ""];
  const more = (count: number) => (count > 0 ? [`- ${t("emails.summary.more", { count })}`] : []);
  if (c.decisions.length) out.push(upper(t("emails.summary.decisions")), ...c.decisions.map((d) => `- ${d}`), ...more(c.more.decisions), "");
  const mine = c.tasks.filter((x) => x.mine);
  const rest = c.tasks.filter((x) => !x.mine);
  if (mine.length) out.push(upper(t("emails.summary.yourTasks")), ...mine.map((x) => `- ${taskLine(x, false)}`), "");
  if (rest.length || (c.more.tasks > 0 && !mine.length)) {
    out.push(upper(t(mine.length ? "emails.summary.otherTasks" : "emails.summary.tasks")), ...rest.map((x) => `- ${taskLine(x, true)}`), ...more(c.more.tasks), "");
  } else if (c.more.tasks > 0) out.push(...more(c.more.tasks), "");
  if (c.other.length) out.push(upper(t("emails.summary.other")), ...c.other.map((o) => `- ${o}`), ...more(c.more.other), "");
  out.push(t("emails.summary.openText", { url: i.buttonHref }));
  if (i.accessNote) out.push(i.accessNote);
  out.push("", "--", "Simon Says", t("emails.summary.why", { orgOf: orgOf(i) }));
  if (i.settingsHref) out.push(t("emails.summary.settingsText", { url: i.settingsHref }));
  out.push(t("emails.summary.unsubscribeText", { url: i.unsubscribeHref }));
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------
// HTML

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

function list(t: Translator, items: string[], more: number, cls = "ink", color = "#171717"): string {
  const rows = items.map(
    (t) =>
      `<tr><td valign="top" class="ink-3" style="width:18px; padding:0 0 8px 0; font-family:${SANS}; font-size:16px; line-height:24px; color:#666666;">&ndash;</td>` +
      `<td valign="top" class="${cls}" style="padding:0 0 8px 0; font-family:${SANS}; font-size:16px; line-height:24px; color:${color};">${t}</td></tr>`,
  );
  if (more > 0) {
    rows.push(
      `<tr><td></td><td class="ink-3" style="padding:0 0 8px 0; font-family:${SANS}; font-size:14px; line-height:22px; color:#666666;">${escapeHtml(t("emails.summary.more", { count: more }))}</td></tr>`,
    );
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join("")}</table>`;
}

function sectionTitle(title: string): string {
  return `<p class="ink-3" style="margin:0 0 12px 0; font-family:${SANS}; font-size:13px; line-height:20px; font-weight:600; letter-spacing:0.02em; text-transform:uppercase; color:#666666;">${title}</p>`;
}

function taskHtml(t: SummaryTask, withOwner: boolean): string {
  const owner = withOwner && t.owner ? `<span style="font-weight:600;">${escapeHtml(t.owner)}:</span> ` : "";
  const due = t.due ? ` <span class="ink-3" style="color:#666666;">(${escapeHtml(t.due)})</span>` : "";
  return `${owner}${escapeHtml(t.text)}${due}`;
}

export function renderSummaryHtml(i: SummaryEmailInput): string {
  const t = tr(i);
  const { title, lead } = heading(i);
  const c = i.content;
  const subject = summarySubject(i.orgName, i.startedAt, i.locale);
  const mine = c.tasks.filter((x) => x.mine);
  const rest = c.tasks.filter((x) => !x.mine);
  const blocks: string[] = [];

  if (mine.length) {
    blocks.push(
      `<tr><td style="padding:0 0 28px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
        `<td class="bg-sunk" style="background-color:#f2f2f2; border-radius:8px; padding:20px 20px 12px 20px;">` +
        sectionTitle(escapeHtml(t("emails.summary.yourTasks"))) +
        list(t, mine.map((x) => taskHtml(x, false)), 0) +
        `</td></tr></table></td></tr>`,
    );
  }
  if (c.decisions.length) {
    blocks.push(`<tr><td style="padding:0 0 20px 0;">${sectionTitle(escapeHtml(t("emails.summary.decisions")))}${list(t, c.decisions.map(escapeHtml), c.more.decisions)}</td></tr>`);
  }
  if (rest.length || c.more.tasks > 0) {
    blocks.push(
      `<tr><td style="padding:0 0 20px 0;">${sectionTitle(escapeHtml(t(mine.length ? "emails.summary.otherTasks" : "emails.summary.tasks")))}${list(
        t,
        rest.map((x) => taskHtml(x, true)),
        c.more.tasks,
        "ink-2",
        "#4d4d4d",
      )}</td></tr>`,
    );
  }
  if (c.other.length) {
    blocks.push(`<tr><td style="padding:0 0 20px 0;">${sectionTitle(escapeHtml(t("emails.summary.other")))}${list(t, c.other.map(escapeHtml), c.more.other, "ink-2", "#4d4d4d")}</td></tr>`);
  }

  const footer = [
    escapeHtml(t("emails.summary.why", { orgOf: orgOf(i) })),
    i.settingsHref
      ? `<a class="link" href="${escapeHtml(i.settingsHref)}" target="_blank" style="color:#0068d6; text-decoration:none;">${escapeHtml(t("emails.summary.settings"))}</a> &middot; `
      : "",
    `<a class="link" href="${escapeHtml(i.unsubscribeHref)}" target="_blank" style="color:#0068d6; text-decoration:none;">${escapeHtml(t("emails.summary.unsubscribe"))}</a>`,
  ];

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
  }
  /* Outlook.com dark mode */
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
    &#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;
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
                ${blocks.join("\n                ")}
                <tr>
                  <td style="padding-top:8px;">
                    <table role="presentation" class="btn-full" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td class="btn-td" bgcolor="#171717" style="background-color:#171717; border-radius:6px;">
                          <a class="btn-a" href="${escapeHtml(i.buttonHref)}" target="_blank" style="display:inline-block; padding:14px 24px; font-family:${SANS}; font-size:16px; line-height:20px; font-weight:500; color:#ffffff; text-decoration:none; border-radius:6px;">${escapeHtml(t("emails.summary.open"))}</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>${
                  i.accessNote
                    ? `
                <tr>
                  <td style="padding-top:16px;">
                    <p class="ink-3" style="margin:0; font-family:${SANS}; font-size:13px; line-height:20px; color:#666666;">${escapeHtml(i.accessNote)}</p>
                  </td>
                </tr>`
                    : ""
                }
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 4px 0 4px;">
              <p class="ink-3" style="margin:0; font-family:${SANS}; font-size:13px; line-height:20px; color:#666666;">${footer[0]}<br>${footer[1]}${footer[2]}</p>
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

/** Subject, preview, HTML and text for one recipient. */
export function renderSummaryEmail(i: SummaryEmailInput): RenderedEmail {
  return { subject: summarySubject(i.orgName, i.startedAt, i.locale), preview: previewText(i), html: renderSummaryHtml(i), text: renderSummaryText(i) };
}
