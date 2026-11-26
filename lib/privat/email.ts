import { sinceLastOrder, type SinceLastItem } from "./since-last";
import { longDay, shortWhen, type PrivatLocale } from "./format";

// The e-mail after a Privat recording, in the invite e-mail's design A ("Calm Geist", like
// lib/summaries/email.ts): one white card on #fafafa, the serif wordmark, one black button, a grey
// footer; dark mode and phone padding only in the <style> block. Swedish or English (the user's
// language). Pure: the sender, the /design gallery and the tests render through here. Every text
// is escaped.

export interface PrivatEmailContent {
  summary: string;
  decisions: string[];
  facts: string[];
  tasks: { text: string; owner: string | null; due: string | null }[];
  questions: string[];
  sinceLast: SinceLastItem[];
}

export interface PrivatEmailInput {
  locale: PrivatLocale;
  contextName: string;
  startedAt: string;
  content: PrivatEmailContent;
  /** The meeting's page in Simon Says. */
  meetingHref: string;
  /** The address's /mejl page (0039), private_summary preselected. */
  unsubscribeHref: string;
}

export interface RenderedPrivatEmail {
  subject: string;
  preview: string;
  html: string;
  text: string;
}

const COPY = {
  sv: {
    subject: (ctx: string, day: string) => `${ctx}: sammanfattning ${day}`,
    title: (ctx: string) => `${ctx}`,
    lead: (day: string) => `Din inspelning ${day}.`,
    summary: "Sammanfattning",
    decisions: "Beslut",
    mine: "Mina uppgifter",
    others: "Andras uppgifter",
    questions: "Öppna frågor",
    facts: "Bra att komma ihåg",
    since: "Sedan sist",
    status: { done: "klart", open: "öppen", not_mentioned: "inte nämnd" },
    more: (n: number) => `… och ${n} till i Simon Says`,
    button: "Öppna i Simon Says",
    footer: "Du får det här mejlet för att du spelade in i Privat på Simon Says. Bara du kan se inspelningen.",
    unsubscribe: "Avsluta prenumeration",
    preview: (d: number, t: number) =>
      [d ? `${d} beslut` : "", t ? `${t} ${t === 1 ? "uppgift" : "uppgifter"}` : ""].filter(Boolean).join(" och ") || "Det viktigaste från inspelningen.",
  },
  en: {
    subject: (ctx: string, day: string) => `${ctx}: summary ${day}`,
    title: (ctx: string) => `${ctx}`,
    lead: (day: string) => `Your recording on ${day}.`,
    summary: "Summary",
    decisions: "Decisions",
    mine: "My tasks",
    others: "Others' tasks",
    questions: "Open questions",
    facts: "Worth remembering",
    since: "Since last time",
    status: { done: "done", open: "open", not_mentioned: "not mentioned" },
    more: (n: number) => `… and ${n} more in Simon Says`,
    button: "Open in Simon Says",
    footer: "You get this e-mail because you recorded in Personal on Simon Says. Only you can see the recording.",
    unsubscribe: "Unsubscribe",
    preview: (d: number, t: number) =>
      [d ? `${d} ${d === 1 ? "decision" : "decisions"}` : "", t ? `${t} ${t === 1 ? "task" : "tasks"}` : ""].filter(Boolean).join(" and ") ||
      "The key points of your recording.",
  },
} as const;

/** At most this many lines per list; the rest are "… och N till". */
export const LIST_MAX = 10;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();

/** "TDDE15: sammanfattning 26 nov 18.05", cut at 90 characters. */
export function privatSubject(locale: PrivatLocale, contextName: string, startedAt: string): string {
  const s = oneLine(COPY[locale].subject(contextName, shortWhen(startedAt, locale)));
  return s.length > 90 ? `${s.slice(0, 89).trimEnd()}…` : s;
}

const taskText = (t: PrivatEmailContent["tasks"][number], withOwner: boolean) =>
  `${withOwner && t.owner ? `${t.owner}: ` : ""}${t.text}${t.due ? ` (${t.due})` : ""}`;

interface Section {
  title: string;
  /** Plain-text lines (escaped for HTML when rendered). */
  lines: string[];
  more: number;
  /** HTML per line, when richer than the escaped text (owner in bold, status in grey). */
  html?: string[];
  boxed?: boolean;
}

function sections(i: PrivatEmailInput): Section[] {
  const c = COPY[i.locale];
  const k = i.content;
  const cap = <T,>(xs: T[]) => ({ shown: xs.slice(0, LIST_MAX), more: Math.max(0, xs.length - LIST_MAX) });
  const out: Section[] = [];
  const mine = cap(k.tasks.filter((t) => !t.owner));
  const others = cap(k.tasks.filter((t) => t.owner));
  if (mine.shown.length) {
    out.push({
      title: c.mine,
      lines: mine.shown.map((t) => taskText(t, false)),
      html: mine.shown.map((t) => `${escapeHtml(t.text)}${t.due ? ` <span class="ink-3" style="color:#666666;">(${escapeHtml(t.due)})</span>` : ""}`),
      more: mine.more,
      boxed: true,
    });
  }
  const decisions = cap(k.decisions);
  if (decisions.shown.length) out.push({ title: c.decisions, lines: decisions.shown, more: decisions.more });
  if (others.shown.length) {
    out.push({
      title: c.others,
      lines: others.shown.map((t) => taskText(t, true)),
      html: others.shown.map(
        (t) =>
          `<span style="font-weight:600;">${escapeHtml(t.owner!)}:</span> ${escapeHtml(t.text)}${t.due ? ` <span class="ink-3" style="color:#666666;">(${escapeHtml(t.due)})</span>` : ""}`,
      ),
      more: others.more,
    });
  }
  const questions = cap(k.questions);
  if (questions.shown.length) out.push({ title: c.questions, lines: questions.shown, more: questions.more });
  const since = cap(sinceLastOrder(k.sinceLast));
  if (since.shown.length) {
    out.push({
      title: c.since,
      lines: since.shown.map((s) => `${s.text}${s.owner ? ` (${s.owner})` : ""} — ${c.status[s.status]}`),
      html: since.shown.map(
        (s) =>
          `${escapeHtml(s.text)}${s.owner ? ` <span class="ink-3" style="color:#666666;">(${escapeHtml(s.owner)})</span>` : ""} <span class="ink-3" style="color:${s.status === "done" ? "#107d32" : "#666666"}; font-weight:600;">— ${escapeHtml(c.status[s.status])}</span>`,
      ),
      more: since.more,
    });
  }
  const facts = cap(k.facts);
  if (facts.shown.length) out.push({ title: c.facts, lines: facts.shown, more: facts.more });
  return out;
}

export function renderPrivatText(i: PrivatEmailInput): string {
  const c = COPY[i.locale];
  const out: string[] = [c.title(oneLine(i.contextName)), "", c.lead(longDay(i.startedAt, i.locale)), ""];
  if (i.content.summary) out.push(c.summary.toUpperCase(), i.content.summary, "");
  for (const s of sections(i)) {
    out.push(s.title.toUpperCase(), ...s.lines.map((l) => `- ${l}`), ...(s.more ? [`- ${c.more(s.more)}`] : []), "");
  }
  out.push(`${c.button}: ${i.meetingHref}`, "", "--", "Simon Says", c.footer, `${c.unsubscribe}: ${i.unsubscribeHref}`);
  return out.join("\n");
}

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

function listHtml(s: Section, moreText: string): string {
  const items = s.html ?? s.lines.map(escapeHtml);
  const rows = items.map(
    (t) =>
      `<tr><td valign="top" class="ink-3" style="width:18px; padding:0 0 8px 0; font-family:${SANS}; font-size:16px; line-height:24px; color:#666666;">&ndash;</td>` +
      `<td valign="top" class="ink" style="padding:0 0 8px 0; font-family:${SANS}; font-size:16px; line-height:24px; color:#171717;">${t}</td></tr>`,
  );
  if (s.more > 0) {
    rows.push(
      `<tr><td></td><td class="ink-3" style="padding:0 0 8px 0; font-family:${SANS}; font-size:14px; line-height:22px; color:#666666;">${escapeHtml(moreText)}</td></tr>`,
    );
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join("")}</table>`;
}

const sectionTitle = (title: string) =>
  `<p class="ink-3" style="margin:0 0 12px 0; font-family:${SANS}; font-size:13px; line-height:20px; font-weight:600; letter-spacing:0.02em; text-transform:uppercase; color:#666666;">${escapeHtml(title)}</p>`;

export function renderPrivatHtml(i: PrivatEmailInput): string {
  const c = COPY[i.locale];
  const subject = privatSubject(i.locale, i.contextName, i.startedAt);
  const blocks = sections(i).map((s) =>
    s.boxed
      ? `<tr><td style="padding:0 0 28px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
        `<td class="bg-sunk" style="background-color:#f2f2f2; border-radius:8px; padding:20px 20px 12px 20px;">${sectionTitle(s.title)}${listHtml(s, c.more(s.more))}</td></tr></table></td></tr>`
      : `<tr><td style="padding:0 0 20px 0;">${sectionTitle(s.title)}${listHtml(s, c.more(s.more))}</td></tr>`,
  );
  return `<!doctype html>
<html lang="${i.locale}" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
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
    ${escapeHtml(privatPreview(i))}
    &#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;
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
                    <h1 class="ink h1" style="margin:0 0 8px 0; font-family:${SANS}; font-size:32px; line-height:38px; font-weight:600; letter-spacing:-0.8px; color:#171717;">${escapeHtml(oneLine(i.contextName))}</h1>
                    <p class="ink-3" style="margin:0 0 24px 0; font-family:${SANS}; font-size:14px; line-height:22px; color:#666666;">${escapeHtml(c.lead(longDay(i.startedAt, i.locale)))}</p>
                    ${i.content.summary ? `<p class="ink-2" style="margin:0 0 32px 0; font-family:${SANS}; font-size:16px; line-height:26px; color:#4d4d4d;">${escapeHtml(i.content.summary)}</p>` : ""}
                  </td>
                </tr>
                ${blocks.join("\n                ")}
                <tr>
                  <td style="padding-top:8px;">
                    <table role="presentation" class="btn-full" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td class="btn-td" bgcolor="#171717" style="background-color:#171717; border-radius:6px;">
                          <a class="btn-a" href="${escapeHtml(i.meetingHref)}" target="_blank" style="display:inline-block; padding:14px 24px; font-family:${SANS}; font-size:16px; line-height:20px; font-weight:500; color:#ffffff; text-decoration:none; border-radius:6px;">${escapeHtml(c.button)}</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 4px 0 4px;">
              <p class="ink-3" style="margin:0; font-family:${SANS}; font-size:13px; line-height:20px; color:#666666;">${escapeHtml(c.footer)}<br><a class="link" href="${escapeHtml(i.unsubscribeHref)}" target="_blank" style="color:#0068d6; text-decoration:none;">${escapeHtml(c.unsubscribe)}</a></p>
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

export function privatPreview(i: PrivatEmailInput): string {
  return COPY[i.locale].preview(i.content.decisions.length, i.content.tasks.length);
}

export function renderPrivatEmail(i: PrivatEmailInput): RenderedPrivatEmail {
  return { subject: privatSubject(i.locale, i.contextName, i.startedAt), preview: privatPreview(i), html: renderPrivatHtml(i), text: renderPrivatText(i) };
}

/** The status words, for the pages ("klart", "öppen", "inte nämnd"). */
export const sinceLastWord = (locale: PrivatLocale, status: SinceLastItem["status"]) => COPY[locale].status[status];
