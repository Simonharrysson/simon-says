import type { docs_v1 } from "@googleapis/docs";

// The text of a picked Google Doc for the protocol import (todo #7), split into protocols. Pure.
// A Doc is NOT assumed to be one meeting: many föreningar keep a running Doc (a year of minutes)
// or one tab per meeting. So:
//   - every tab (and child tab) is read, paragraphs and table cells, EXCEPT transcript tabs
//     (Simon Says' "Transkript" tab, or any tab whose id is in `skipTabIds`);
//   - the text is split deterministically on dated protocol headings ("Protokoll 2025-09-02",
//     "Styrelsemöte 3 september 2025", "Datum: 10/9-25") and on dated tabs, one section per
//     meeting date;
//   - a Doc that holds many dates but has no reliable split is refused, never collapsed into one
//     protocol.
// The text only goes to the extraction call; it is never stored or logged.

type Content = docs_v1.Schema$StructuralElement[] | undefined;

function contentText(content: Content, out: string[]): void {
  for (const el of content ?? []) {
    if (el.paragraph) {
      out.push((el.paragraph.elements ?? []).map((e) => e.textRun?.content ?? "").join("").replace(/\n$/, ""));
    } else if (el.table) {
      for (const row of el.table.tableRows ?? []) {
        const cells = (row.tableCells ?? []).map((c) => {
          const inner: string[] = [];
          contentText(c.content, inner);
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
}

/** A transcript tab: Simon Says names it "Transkript"; when unsure, any tab titled Transkript…/Transcript…. */
export const isTranscriptTitle = (title: string) => /^\s*(transkript|transcript)/i.test(title);

/** The Doc's tabs in order (child tabs after their parent), transcript tabs left out. */
export function docTabs(doc: docs_v1.Schema$Document, skipTabIds: Set<string> = new Set()): DocTab[] {
  if (!doc.tabs?.length) {
    const out: string[] = [];
    contentText(doc.body?.content, out);
    return [{ title: "", text: tidy(out) }];
  }
  const tabs: DocTab[] = [];
  const walk = (list: docs_v1.Schema$Tab[] | undefined) => {
    for (const tab of list ?? []) {
      const title = tab.tabProperties?.title ?? "";
      const id = tab.tabProperties?.tabId ?? "";
      if (!isTranscriptTitle(title) && !(id && skipTabIds.has(id)) && tab.documentTab) {
        const out: string[] = [];
        contentText(tab.documentTab.body?.content, out);
        tabs.push({ title, text: tidy(out) });
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
// Dates and the split

const MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
// English too: international föreningar write "Board meeting 4 Sep 2025", "12 October 2025".
const MONTHS_EN = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = `(${[...MONTHS, ...MONTHS_EN].join("|")}|jan|feb|mar|apr|jun|jul|aug|sep|sept|okt|oct|nov|dec)\\.?`;
const monthIndex = (m: string) => {
  const k = m.toLowerCase().replace(".", "").slice(0, 3);
  const sv = MONTHS.findIndex((x) => x.startsWith(k));
  return sv >= 0 ? sv : MONTHS_EN.findIndex((x) => x.startsWith(k));
};

function ymd(y: string, m: string, d: string): string | null {
  const s = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const t = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s ? s : null;
}

const DATE_RES: { re: RegExp; iso: (m: RegExpExecArray) => string | null }[] = [
  { re: /\b(20\d\d)-(\d{1,2})-(\d{1,2})\b/g, iso: (m) => ymd(m[1], m[2], m[3]) },
  {
    re: new RegExp(`\\b(\\d{1,2})\\s+${MONTH_RE}\\s+(20\\d\\d)\\b`, "giu"),
    iso: (m) => {
      const k = monthIndex(m[2]);
      return k < 0 ? null : ymd(m[3], String(k + 1), m[1]);
    },
  },
  { re: /\b(\d{1,2})[./](\d{1,2})[./](20\d\d)\b/g, iso: (m) => ymd(m[3], m[2], m[1]) },
  // "10/9-25", "10/9 -25" (day/month-yy).
  { re: /\b(\d{1,2})\/(\d{1,2})\s?-\s?(\d\d)\b/g, iso: (m) => ymd(`20${m[3]}`, m[2], m[1]) },
];

/** Every full date (with a year) in `text`, as YYYY-MM-DD, in order of appearance. */
export function datesIn(text: string): string[] {
  const found: { at: number; iso: string }[] = [];
  for (const { re, iso } of DATE_RES) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const d = iso(m);
      if (d) found.push({ at: m.index, iso: d });
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.iso);
}

const HEAD_WORD = /^(?:§\s*\d+\s*)?(protokoll|mötesprotokoll|styrelsemöte|styrelseprotokoll|medlemsmöte|årsmöte|extrainsatt|sammanträde|möte|datum|tid och plats|board meeting|minutes)(?![\p{L}])/iu;
const PROTOCOL_WORD = /(?<![\p{L}])(protokoll|styrelsemöte|mötesprotokoll|medlemsmöte|årsmöte|mtg|minutes)(?![\p{L}])/iu;
const TITLE_ONLY = /^(protokoll|mötesprotokoll|styrelsemöte|styrelseprotokoll|medlemsmöte|årsmöte)(?![\p{L}])[^0-9]{0,80}$/iu;

/** The date of a protocol heading line, else null: short, holds a date, and starts with a protocol word or the date. */
export function headingDate(line: string): string | null {
  const l = line.trim();
  if (!l || l.length > 90 || /(?<![\p{L}])(nästa|next)(?![\p{L}])/iu.test(l)) return null;
  const d = datesIn(l);
  if (!d.length) return null;
  if (HEAD_WORD.test(l)) return d[0];
  if (/^\d/.test(l) && l.replace(/^[\d/.\-\s]+/, "").split(/\s+/).filter(Boolean).length <= 6) return d[0];
  // "Ridån styrelsemöte 18/2-26": a protocol word anywhere in a short line that holds a date.
  if (PROTOCOL_WORD.test(l) && l.split(/\s+/).length <= 8) return d[0];
  return null;
}

export interface ProtocolSection {
  /** The heading date the split found (null: one undated section). */
  date: string | null;
  /** Title for the extraction: the Doc title, plus the tab title when it has one. */
  title: string;
  text: string;
}

export type SplitResult = { ok: true; sections: ProtocolSection[] } | { ok: false; reason: "empty" | "many-meetings" | "too-many" };

/** At or above this many distinct full dates in one unsplit, long section, it is many meetings, not one. */
const MANY_DATES = 4;
const LONG_SECTION = 8000;
export const MAX_SECTIONS = 60;

function splitLines(text: string): { date: string | null; text: string }[] {
  const lines = text.split("\n");
  const cuts: { at: number; date: string }[] = [];
  let current: string | null = null;
  lines.forEach((line, i) => {
    const d = headingDate(line);
    if (d && d !== current) {
      current = d;
      cuts.push({ at: i, date: d });
    }
  });
  if (cuts.length < 2) return [{ date: cuts[0]?.date ?? null, text }];
  // A cut moves up over the undated title lines right above it ("Protokoll styrelsemöte X" before "Datum: …").
  const starts = cuts.map((c) => {
    let at = c.at;
    for (let k = 0; k < 3 && at > 0; k++) {
      const prev = lines[at - 1].trim();
      if (prev === "" || TITLE_ONLY.test(prev)) at--;
      else break;
    }
    return { at, date: c.date };
  });
  const head = lines.slice(0, starts[0].at).join("\n").trim();
  return starts.map((s, k) => {
    const body = lines.slice(s.at, starts[k + 1]?.at ?? lines.length).join("\n").trim();
    return { date: s.date, text: k === 0 && head ? `${head}\n${body}` : body };
  });
}

/**
 * The picked Doc → one section per meeting. Tabs are split on their own; a tab with no date in
 * its title or first lines (an appendix) joins the section before it. Refused: an empty Doc;
 * more than MAX_SECTIONS meetings; a long section that still holds MANY_DATES or more distinct
 * dates (no reliable split).
 */
export function splitProtocols(docTitle: string, tabs: DocTab[]): SplitResult {
  const parts: ProtocolSection[] = [];
  for (const tab of tabs.filter((t) => t.text.trim())) {
    const tabDate = datesIn(tab.title)[0] ?? null;
    const title = [docTitle, tab.title].filter(Boolean).join(" · ");
    splitLines(tab.text).forEach((p, k) => {
      const date = p.date ?? (k === 0 ? tabDate : null);
      const dated = date !== null || datesIn(p.text.split("\n").slice(0, 5).join("\n")).length > 0;
      if (!dated && parts.length) {
        const last = parts[parts.length - 1];
        last.text = `${last.text}\n\n${p.text}`;
      } else {
        parts.push({ date, title, text: p.text });
      }
    });
  }
  if (!parts.length) return { ok: false, reason: "empty" };
  if (parts.length > MAX_SECTIONS) return { ok: false, reason: "too-many" };
  for (const p of parts) {
    if (p.text.length > LONG_SECTION && new Set(datesIn(p.text)).size >= MANY_DATES) return { ok: false, reason: "many-meetings" };
  }
  return { ok: true, sections: parts };
}

export const MANY_MEETINGS_MESSAGE = "Dokumentet verkar innehålla flera möten — välj ett protokoll per dokument eller dela upp det.";
