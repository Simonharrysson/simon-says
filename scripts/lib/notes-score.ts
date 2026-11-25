// Scoring for the notes eval (pure: no API, no server-only imports, unit-tested in
// notes-score.test.ts). A fixture's expected file lists the decisions/actions that must be in the
// final notes and the `must_not` items that must not be, neither at the end nor lingering live.

import type { NotesItem, NotesSection } from "@/lib/notes/schema";

/**
 * Groups of alternatives; every group must hit. Case-insensitive, thousands separators ignored,
 * whole words by default; `*` at the start or end of an alternative drops the word boundary on that
 * side (stems and Swedish compounds: "faktur*", "*avgift*").
 */
export type Match = string[][];

export interface MustNot {
  key: string;
  text: string;
  sections: NotesSection[];
  match: Match;
  /**
   * Owner-switch check: only items for this (old) owner count, by the owner field or the old
   * owner's first name in the item text.
   */
  owner?: string;
  /** An item that also matches these groups is allowed (a tabled question recorded only as deferred, a reversal). */
  unless?: Match;
  /**
   * Meeting time (ms) from which the item is wrong. Live checks only look at ticks whose transcript
   * reaches this point (default 0: every tick). Used for a decision that was right until reversed.
   */
  fromMs?: number;
}

export interface Expected {
  source?: string;
  orgName?: string;
  speakerNames?: Record<string, string>;
  languages?: string[];
  traps?: string[];
  decisions?: { key: string; text: string; match: Match }[];
  action_items?: { key: string; owner?: string; text: string; due?: string; match: Match }[];
  /**
   * Items that must NOT be in the notes: in one of `sections`, text plus owner matching `match`.
   * Covers "no promises", proposals changed before they were decided, items tabled to a later
   * meeting, reversed decisions, owner switches and duplicates of human-typed lines.
   */
  must_not?: MustNot[];
  /** Lines a person typed into the notes tab themselves, visible from meeting time `atMs` on. */
  human_lines?: { atMs: number; section: NotesSection; line: string }[];
}

export const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[   ]/g, " ")
    .replace(/(\d)[ .](?=\d{3}\b)/g, "$1");

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = new Map<string, RegExp>();

function altPattern(alt: string): RegExp {
  let re = patterns.get(alt);
  if (!re) {
    const a = norm(alt);
    const open = a.startsWith("*");
    const close = a.length > 1 && a.endsWith("*");
    const core = a.slice(open ? 1 : 0, close ? -1 : undefined);
    re = new RegExp(`${open ? "" : "(?<![\\p{L}\\p{N}])"}${escapeRe(core)}${close ? "" : "(?![\\p{L}\\p{N}])"}`, "u");
    patterns.set(alt, re);
  }
  return re;
}

export function matches(text: string, groups: Match): boolean {
  const t = norm(text);
  return groups.every((alts) => alts.some((a) => altPattern(a).test(t)));
}

const firstName = (name: string) => name.split(" ")[0];
const hasName = (text: string, name: string) => matches(text, [[firstName(name)]]);

/** One line as the notes tab shows it (the same shape as formatItem, without its Doc cleaning). */
export function itemLine(i: NotesItem): string {
  if (i.section === "action") return `☐ ${i.owner ? `${i.owner}: ` : ""}${i.text}${i.due ? ` (${i.due})` : ""}`;
  if (i.section === "decision") return `✓ ${i.text}`;
  return i.text;
}

export function mustNotHit(items: NotesItem[], m: MustNot): NotesItem | undefined {
  return items.find(
    (i) =>
      m.sections.includes(i.section) &&
      matches(`${i.text} ${i.owner ?? ""}`, m.match) &&
      !(m.unless && matches(i.text, m.unless)) &&
      (!m.owner || hasName(`${i.owner ?? ""} ${i.text}`, m.owner)),
  );
}

export interface Score {
  found: number;
  total: number;
  recall: string[];
  /** must_not entries in the final notes (fails the bar). */
  mustNot: string[];
  /** must_not entries present in ≥ 2 consecutive ticks from `fromMs` on (fails the bar: visible live, not a blip). */
  mustNotPersistent: string[];
  /** must_not entries present in exactly isolated single ticks (warning only). */
  mustNotLive: string[];
}

/** Per-tick items with the meeting time the tick's transcript reaches. */
export interface TickItems {
  items: NotesItem[];
  /** Meeting time covered by the transcript at this tick (ms). */
  atMs: number;
}

export function score(items: NotesItem[], expected: Expected, ticks: TickItems[] = []): Score {
  let found = 0;
  let total = 0;
  const recall: string[] = [];
  for (const d of expected.decisions ?? []) {
    total++;
    const hit = items.find((i) => i.section === "decision" && matches(i.text, d.match));
    if (hit) found++;
    recall.push(`${hit ? "FOUND  " : "MISSING"} ${d.key} ${d.text}${hit ? `  ← ${hit.id} "${hit.text}"` : ""}`);
  }
  for (const a of expected.action_items ?? []) {
    total++;
    const hit = items.find(
      (i) =>
        i.section === "action" &&
        matches(`${i.text} ${i.owner ?? ""}`, a.match) &&
        (!a.owner || hasName(`${i.owner ?? ""} ${i.text}`, a.owner)),
    );
    if (hit) found++;
    recall.push(`${hit ? "FOUND  " : "MISSING"} ${a.key} ${a.owner ?? "–"}: ${a.text}${hit ? `  ← ${hit.id} ${itemLine(hit)}` : ""}`);
  }
  const mustNot: string[] = [];
  const mustNotPersistent: string[] = [];
  const mustNotLive: string[] = [];
  for (const m of expected.must_not ?? []) {
    const hit = mustNotHit(items, m);
    if (hit) mustNot.push(`${m.key} ${m.text}  ← ${hit.id} ${itemLine(hit)}`);
    let run = 0;
    let longest = 0;
    let first: NotesItem | undefined;
    for (const t of ticks) {
      if (t.atMs <= (m.fromMs ?? 0)) continue;
      const h = mustNotHit(t.items, m);
      run = h ? run + 1 : 0;
      longest = Math.max(longest, run);
      first ??= h;
    }
    const line = first ? `${m.key} ${m.text}  ← ${first.id} ${itemLine(first)}` : "";
    if (longest >= 2) mustNotPersistent.push(`${line} (${longest} ticks in a row)`);
    else if (longest === 1) mustNotLive.push(`${line} (1 tick)`);
  }
  return { found, total, recall, mustNot, mustNotPersistent, mustNotLive };
}

/** Whether a score meets the quality bars (cost and churn are checked by the caller). */
export const scorePasses = (s: Score) => s.found === s.total && s.mustNot.length === 0 && s.mustNotPersistent.length === 0;

/**
 * $0 sanity check of a fixture's expected file: each expected item satisfies its own match, no
 * must_not matches an expected item, human lines are caught by some must_not. Returns problems.
 */
export function checkExpected(expected: Expected): string[] {
  const problems: string[] = [];
  const names = Object.values(expected.speakerNames ?? {});
  for (const d of expected.decisions ?? []) if (!matches(d.text, d.match)) problems.push(`${d.key}: text does not satisfy its match`);
  for (const a of expected.action_items ?? []) {
    if (!matches(`${a.text} ${a.owner ?? ""}`, a.match)) problems.push(`${a.key}: text does not satisfy its match`);
    if (a.owner && !names.includes(a.owner)) problems.push(`${a.key}: owner ${a.owner} not in speakerNames`);
  }
  for (const m of expected.must_not ?? []) {
    const fake = (section: NotesSection, text: string, owner?: string): NotesItem => ({ id: "x", section, text, owner });
    for (const d of expected.decisions ?? []) if (mustNotHit([fake("decision", d.text)], m)) problems.push(`${m.key} matches expected ${d.key}`);
    for (const a of expected.action_items ?? []) if (mustNotHit([fake("action", a.text, a.owner)], m)) problems.push(`${m.key} matches expected ${a.key}`);
  }
  for (const h of expected.human_lines ?? [])
    if (!(expected.must_not ?? []).some((m) => matches(h.line, m.match))) problems.push(`human line "${h.line}" has no must_not guarding a duplicate`);
  return problems;
}
