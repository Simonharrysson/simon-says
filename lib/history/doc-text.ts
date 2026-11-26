import type { docs_v1 } from "@googleapis/docs";

// The text of a picked Google Doc for the protocol import (todo #7), split into protocols. Pure.
// A Doc is NOT assumed to be one meeting: many föreningar keep a running Doc (a year of minutes)
// or one tab per meeting. So:
//   - every tab (and child tab) is read, paragraphs and table cells, EXCEPT transcript tabs (a
//     title holding "transkript"/"transcript" anywhere, or a tab id in `skipTabIds`);
//   - the text is split deterministically on meeting HEADINGS: a line in a Docs heading style, a
//     tab title, or a short standalone line that is a date plus at most a meeting word and one
//     more word ("Protokoll styrelsemöte 2025-09-02", "Datum: 2025-09-02", "tis 12/3",
//     "Board meeting 4 Sep 2025"). A body line that merely holds a date ("Möte med kommunen
//     2026-04-15", "Datum för städdag: 2026-04-15", "§4 Årsmöte 15 mars 2026 i aulan") never is;
//   - a cut stays only when the sections on both sides look like protocols (≥ 2 agenda lines);
//   - dates without a year ("12/3", "12 mars") get their year from the Doc's date and the order
//     of the meetings (flagged as inferred); when that is not possible the Doc is refused;
//   - a long section that still holds many dates is refused, never collapsed into one protocol.
// The text only goes to the extraction call; it is never stored or logged.

type Content = docs_v1.Schema$StructuralElement[] | undefined;

const HEADING_STYLE = /^(HEADING_[1-6]|TITLE|SUBTITLE)$/;

function contentText(content: Content, out: string[], headings: Set<string>): void {
  for (const el of content ?? []) {
    if (el.paragraph) {
      const line = (el.paragraph.elements ?? []).map((e) => e.textRun?.content ?? "").join("").replace(/\n$/, "");
      out.push(line);
      if (HEADING_STYLE.test(el.paragraph.paragraphStyle?.namedStyleType ?? "") && line.trim()) headings.add(line.trim());
    } else if (el.table) {
      for (const row of el.table.tableRows ?? []) {
        const cells = (row.tableCells ?? []).map((c) => {
          const inner: string[] = [];
          contentText(c.content, inner, new Set());
          return inner.map((l) => l.trim()).filter(Boolean).join(" / ");
        });
        out.push(cells.join(" | "));
      }
    }
    // A table of contents repeats the headings: skipped.
  }
}

const tidy = (lines: string[]) =>
  lines
    .join("\n")
    .replace(/\u000b/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export interface DocTab {
  title: string;
  text: string;
  /** Lines (trimmed) written in a Docs heading style. */
  headings?: string[];
}

/** A transcript tab: "transkript"/"transcript" anywhere in its title ("Transkript", "Möte 3 – transkript"). */
export const isTranscriptTitle = (title: string) => /transkript|transcript/i.test(title);

/** The Doc's tabs in order (child tabs after their parent), transcript tabs left out. */
export function docTabs(doc: docs_v1.Schema$Document, skipTabIds: Set<string> = new Set()): DocTab[] {
  if (!doc.tabs?.length) {
    const out: string[] = [];
    const headings = new Set<string>();
    contentText(doc.body?.content, out, headings);
    return [{ title: "", text: tidy(out), headings: [...headings] }];
  }
  const tabs: DocTab[] = [];
  const walk = (list: docs_v1.Schema$Tab[] | undefined) => {
    for (const tab of list ?? []) {
      const title = tab.tabProperties?.title ?? "";
      const id = tab.tabProperties?.tabId ?? "";
      if (!isTranscriptTitle(title) && !(id && skipTabIds.has(id)) && tab.documentTab) {
        const out: string[] = [];
        const headings = new Set<string>();
        contentText(tab.documentTab.body?.content, out, headings);
        tabs.push({ title, text: tidy(out), headings: [...headings] });
      }
      walk(tab.childTabs);
    }
  };
  walk(doc.tabs);
  return tabs;
}

/** All text of a Doc (transcript tabs left out). */
export function docPlainText(doc: docs_v1.Schema$Document, skipTabIds?: Set<string>): string {
  return docTabs(doc, skipTabIds)
    .map((t) => t.text)
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------------------------
// Dates

const MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
// English too: international föreningar write "Board meeting 4 Sep 2025", "12 October 2025".
const MONTHS_EN = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = `(${[...MONTHS, ...MONTHS_EN].join("|")}|jan|feb|mar|apr|jun|jul|aug|sep|sept|okt|oct|nov|dec)\\.?`;
const monthIndex = (m: string) => {
  const k = m.toLowerCase().replace(".", "").slice(0, 3);
  const sv = MONTHS.findIndex((x) => x.startsWith(k));
  return sv >= 0 ? sv : MONTHS_EN.findIndex((x) => x.startsWith(k));
};

const pad = (n: number) => String(n).padStart(2, "0");
function ymd(y: number, m: number, d: number): string | null {
  const s = `${y}-${pad(m)}-${pad(d)}`;
  const t = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s ? s : null;
}
/** A month/day that exists in some year (29 Feb included). */
const validMd = (m: number, d: number) => ymd(2024, m, d) !== null;

/** A date in a text: with a year (`iso`) or without (`md`, "MM-DD"). */
export interface DateMark {
  at: number;
  end: number;
  iso: string | null;
  md: string;
}

const WITH_YEAR: { re: RegExp; parts: (m: RegExpExecArray) => [number, number, number] | null }[] = [
  { re: /\b(20\d\d)-(\d{1,2})-(\d{1,2})\b/g, parts: (m) => [+m[1], +m[2], +m[3]] },
  { re: new RegExp(`\\b(\\d{1,2})\\s+${MONTH_RE}\\s+(20\\d\\d)\\b`, "giu"), parts: (m) => (monthIndex(m[2]) < 0 ? null : [+m[3], monthIndex(m[2]) + 1, +m[1]]) },
  { re: /\b(\d{1,2})[./](\d{1,2})[./](20\d\d)\b/g, parts: (m) => [+m[3], +m[2], +m[1]] },
  // "10/9-25", "10/9 -25" (day/month-yy).
  { re: /\b(\d{1,2})\/(\d{1,2})\s?-\s?(\d\d)\b/g, parts: (m) => [2000 + +m[3], +m[2], +m[1]] },
];
const NO_YEAR: { re: RegExp; parts: (m: RegExpExecArray) => [number, number] | null }[] = [
  // "12/3" (day/month), not a fraction of a longer number, not followed by a year.
  { re: /(?<![\d/.])(\d{1,2})\/(\d{1,2})(?![\d/]|\s?-\s?\d)/g, parts: (m) => [+m[2], +m[1]] },
  // "12 mars", "4 Sep" without a year after it.
  { re: new RegExp(`\\b(\\d{1,2})\\s+${MONTH_RE}(?![\\p{L}])(?!\\s+\\d)`, "giu"), parts: (m) => (monthIndex(m[2]) < 0 ? null : [monthIndex(m[2]) + 1, +m[1]]) },
];

/** Every date in `text`, with or without a year, in order of appearance. */
export function dateMarks(text: string): DateMark[] {
  const found: DateMark[] = [];
  for (const { re, parts } of WITH_YEAR) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const p = parts(m);
      const iso = p && ymd(p[0], p[1], p[2]);
      if (iso) found.push({ at: m.index, end: m.index + m[0].length, iso, md: iso.slice(5) });
    }
  }
  const taken = (a: number, b: number) => found.some((f) => a < f.end && b > f.at);
  for (const { re, parts } of NO_YEAR) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const p = parts(m);
      if (!p || !validMd(p[0], p[1]) || taken(m.index, m.index + m[0].length)) continue;
      found.push({ at: m.index, end: m.index + m[0].length, iso: null, md: `${pad(p[0])}-${pad(p[1])}` });
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

/** Every full date (with a year) in `text`, as YYYY-MM-DD, in order of appearance. */
export const datesIn = (text: string): string[] => dateMarks(text).flatMap((d) => (d.iso ? [d.iso] : []));

// ---------------------------------------------------------------------------------------------
// Headings

const MEETING_WORD =
  /(?<![\p{L}])(protokoll|mötesprotokoll|styrelsemöte|styrelseprotokoll|medlemsmöte|årsmöte|extrainsatt|extra|möte|mtg|datum|board meeting|meeting|minutes|protocol|date)(?![\p{L}])/giu;
const WEEKDAY =
  /(?<![\p{L}])(måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag|mån|tis|ons|tors|tor|fre|lör|sön|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\.?(?![\p{L}])/giu;
const NUMBERED = /^(§\s*\d+|\d{1,2}[.)]\s)/;

/**
 * The date of a meeting heading, else null. A line is a heading when it is short and holds a
 * date, nothing about the next meeting, and besides the date only:
 *   - (Docs heading style or tab title) at most 4 more words;
 *   - (plain line) nothing, or a meeting word plus at most one more word ("Ridån styrelsemöte
 *     18/2-26"), and is not a numbered agenda item.
 */
export function headingMark(line: string, styled = false): DateMark | null {
  const l = line.trim();
  if (!l || l.length > (styled ? 90 : 60) || /(?<![\p{L}])(nästa|next|kommande)(?![\p{L}])/iu.test(l)) return null;
  const marks = dateMarks(l);
  if (!marks.length) return null;
  if (!styled && NUMBERED.test(l)) return null;
  let rest = l;
  for (const m of [...marks].reverse()) rest = rest.slice(0, m.at) + " " + rest.slice(m.end);
  const hasMeetingWord = new RegExp(MEETING_WORD.source, "iu").test(rest);
  rest = rest.replace(MEETING_WORD, " ").replace(WEEKDAY, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const words = rest ? rest.split(/\s+/).length : 0;
  if (styled) return words <= 4 ? marks[0] : null;
  return words === 0 || (hasMeetingWord && words <= 1) ? marks[0] : null;
}

/** Date (YYYY-MM-DD) of a heading line with a year, else null (kept for callers and tests). */
export const headingDate = (line: string, styled = false): string | null => headingMark(line, styled)?.iso ?? null;

/** An agenda-ish line: "§3 Ekonomi", "1. Val av justerare", "* Economy", "ekonomi:", "EKONOMI", or a styled heading. */
function isAgendaLine(line: string, styled: boolean): boolean {
  const l = line.trim();
  if (l.length < 2 || l.length > 60) return false;
  if (styled) return true;
  if (/^(§\s*\d+|\d{1,2}[.)])\s*\p{L}/u.test(l) || /^[*•]\s+\p{L}/u.test(l)) return true;
  // The closing item, also written with its content on the same line ("AOB: nothing", "övr: -").
  if (/^(övrigt|övr|övriga frågor|aob|any other business|mötets avslutande)(?![\p{L}])/iu.test(l)) return true;
  if (/^[\p{L}][\p{L} /&-]{0,40}:\s*-?$/u.test(l) && l.split(/\s+/).length <= 4) return true;
  return /^[\p{Lu} /&-]{3,40}$/u.test(l) && /\p{Lu}{2}/u.test(l) && l.split(/\s+/).length <= 5;
}

const MIN_AGENDA_LINES = 2;

// ---------------------------------------------------------------------------------------------
// The split

export interface ProtocolSection {
  /** The meeting's date from its heading (YYYY-MM-DD), null when the section has none. */
  date: string | null;
  /** True when the heading had no year and it was inferred (shown to the admin to check). */
  dateInferred: boolean;
  /** Title for the extraction: the Doc title, plus the tab title when it has one. */
  title: string;
  text: string;
}

export type SplitResult = { ok: true; sections: ProtocolSection[] } | { ok: false; reason: "empty" | "many-meetings" | "too-many" };

/** At or above this many distinct dates (with or without a year) in one long section, it is many meetings, not one. */
const MANY_DATES = 4;
const LONG_SECTION = 8000;
export const MAX_SECTIONS = 60;

interface Piece {
  mark: DateMark | null;
  text: string;
}

function splitLines(tab: DocTab): Piece[] {
  const lines = tab.text.split("\n");
  const styled = new Set((tab.headings ?? []).map((h) => h.trim()));
  let cuts: { at: number; mark: DateMark }[] = [];
  let current: string | null = null;
  lines.forEach((line, i) => {
    const mark = headingMark(line, styled.has(line.trim()));
    if (mark && (mark.iso ?? mark.md) !== current) {
      current = mark.iso ?? mark.md;
      cuts.push({ at: i, mark });
    }
  });
  const build = () => {
    // A cut moves up over undated title lines right above it ("Protokoll styrelsemöte X" before "Datum: …").
    const starts = cuts.map((c) => {
      let at = c.at;
      for (let k = 0; k < 3 && at > 0; k++) {
        const prev = lines[at - 1].trim();
        if (prev === "" || (prev.length <= 80 && /^(protokoll|mötesprotokoll|styrelsemöte|styrelseprotokoll|medlemsmöte|årsmöte|minutes|board meeting)(?![\p{L}])[^0-9]*$/iu.test(prev))) at--;
        else break;
      }
      return at;
    });
    return cuts.map((c, k) => {
      const from = k === 0 ? 0 : starts[k];
      const to = starts[k + 1] ?? lines.length;
      return { mark: c.mark, text: lines.slice(from, to).join("\n").trim() };
    });
  };
  if (cuts.length < 2) return [{ mark: cuts[0]?.mark ?? null, text: tab.text }];
  // Keep a cut only when the section it opens looks like a protocol (≥ 2 agenda lines), and the first one too.
  for (;;) {
    const pieces = build();
    const agenda = (p: Piece) => p.text.split("\n").filter((x) => isAgendaLine(x, styled.has(x.trim()))).length;
    const bad = pieces.findIndex((p, k) => k > 0 && agenda(p) < MIN_AGENDA_LINES);
    if (bad > 0) {
      cuts = cuts.filter((_, k) => k !== bad);
      continue;
    }
    if (pieces.length > 1 && agenda(pieces[0]) < MIN_AGENDA_LINES) {
      cuts = cuts.filter((_, k) => k !== 1);
      continue;
    }
    return pieces;
  }
}

/**
 * Years for headings without one: walking back from the last meeting, each year is the one that
 * keeps the meetings in order and the last one on or before `referenceDate` (the Doc's last
 * edit); a heading with a year anchors the ones before it. Null when it cannot be done safely
 * (no reference date, or the result is not in order).
 */
function inferYears(marks: (DateMark | null)[], referenceDate: string | undefined): (string | null)[] | null {
  if (marks.every((m) => !m || m.iso)) return marks.map((m) => m?.iso ?? null);
  if (!referenceDate) return null;
  const out: (string | null)[] = marks.map(() => null);
  let next = referenceDate;
  for (let k = marks.length - 1; k >= 0; k--) {
    const m = marks[k];
    if (!m) continue;
    if (m.iso) {
      if (m.iso > next) return null;
      out[k] = m.iso;
      next = m.iso;
      continue;
    }
    const year = Number(next.slice(0, 4));
    const iso = m.md <= next.slice(5) ? `${year}-${m.md}` : `${year - 1}-${m.md}`;
    if (!ymd(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10)))) return null;
    out[k] = iso;
    next = iso;
  }
  return out;
}

/**
 * The picked Doc → one section per meeting. Tabs are split on their own; a tab with no date in
 * its title or first lines (an appendix) joins the section before it. Refused: an empty Doc; more
 * than MAX_SECTIONS meetings; yearless headings whose years cannot be inferred; a long section
 * that still holds MANY_DATES or more distinct dates (no reliable split).
 * `referenceDate`: the Doc's last edit (YYYY-MM-DD), for headings without a year.
 */
export function splitProtocols(docTitle: string, tabs: DocTab[], opts: { referenceDate?: string } = {}): SplitResult {
  const parts: { mark: DateMark | null; title: string; text: string }[] = [];
  for (const tab of tabs.filter((t) => t.text.trim())) {
    const tabMark = tab.title ? headingMark(tab.title, true) : null;
    const title = [docTitle, tab.title].filter(Boolean).join(" · ");
    splitLines(tab).forEach((p, k) => {
      const mark = p.mark ?? (k === 0 ? tabMark : null);
      const dated = mark !== null || dateMarks(p.text.split("\n").slice(0, 5).join("\n")).length > 0;
      if (!dated && parts.length) {
        const last = parts[parts.length - 1];
        last.text = `${last.text}\n\n${p.text}`;
      } else {
        parts.push({ mark, title, text: p.text });
      }
    });
  }
  if (!parts.length) return { ok: false, reason: "empty" };
  if (parts.length > MAX_SECTIONS) return { ok: false, reason: "too-many" };
  for (const p of parts) {
    if (p.text.length > LONG_SECTION && new Set(dateMarks(p.text).map((d) => d.iso ?? d.md)).size >= MANY_DATES) return { ok: false, reason: "many-meetings" };
  }
  const years = inferYears(
    parts.map((p) => p.mark),
    opts.referenceDate,
  );
  if (!years) {
    // Several meetings whose years are unknown: unsure, so refused. One meeting: no date, the
    // extraction or the file's date decides.
    if (parts.length > 1) return { ok: false, reason: "many-meetings" };
    return { ok: true, sections: [{ date: null, dateInferred: false, title: parts[0].title, text: parts[0].text }] };
  }
  return {
    ok: true,
    sections: parts.map((p, k) => ({ date: years[k], dateInferred: Boolean(p.mark && !p.mark.iso), title: p.title, text: p.text })),
  };
}

export const MANY_MEETINGS_MESSAGE = "Dokumentet verkar innehålla flera möten — välj ett protokoll per dokument eller dela upp det.";
