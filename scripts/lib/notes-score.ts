// Scoring for the notes eval (pure: no API, no server-only imports, unit-tested in
// notes-score.test.ts). A fixture's expected file lists the decisions/actions that must be in the
// final notes and the `must_not` items that must not be, neither at the end nor lingering live.

import type { ItemRole } from "@/lib/db/types";
import type { NotesItem, NotesSection } from "@/lib/notes/schema";
import { ownerLabel, resolveOwner } from "@/lib/people/roles";

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
  decisions?: { key: string; text: string; match: Match; /** Agenda key (`ag-<n>`) or `notes` the item must sit under. */ anchor?: string }[];
  action_items?: {
    key: string;
    owner?: string;
    text: string;
    due?: string;
    match: Match;
    anchor?: string;
    /** The label the format shows for the owner (their role). */
    ownerLabel?: string;
  }[];
  /** Agenda mode: the agenda Doc's items, as the tick's agenda context has them, and its standard format. */
  agenda?: { profile: "veckomote" | "styrelseprotokoll"; items: { key: string; label: string; role: ItemRole; sub?: string[] }[] };
  people?: { name: string; role: string | null }[];
  /** Agenda mode: last meeting's open tasks, pre-filled as c1…; `done` is what the meeting reports. */
  carried?: { id: string; owner: string; text: string; done: boolean }[];
  /** Agenda mode: what was said in the Må-runda; with hiding on (opt-in) none of it may reach the notes. */
  checkin?: { match: Match };
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

/** The fixture's people as resolveOwner takes them (the id is not used). */
export const rolePeople = (e: Expected) => (e.people ?? []).map((p, k) => ({ id: `p${k}`, name: p.name, role: p.role }));

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
  /** Agenda mode: expected decisions/actions with an `anchor` whose matched final item has it. */
  placement: { ok: number; total: number };
  /** Agenda mode: actions whose owner's role label is the expected `ownerLabel`. */
  roles: { ok: number; total: number };
  /** Agenda mode: carried tasks whose final `done` is the expected one. */
  followup: { ok: number; total: number };
  /**
   * Agenda mode: items under a followup item; with Må-runda hiding on also Må-runda content in the
   * final or any live notes, or items under the checkin item.
   */
  checkinLeaks: string[];
}

/** Per-tick items with the meeting time the tick's transcript reaches. */
export interface TickItems {
  items: NotesItem[];
  /** Meeting time covered by the transcript at this tick (ms). */
  atMs: number;
}

export function score(items: NotesItem[], expected: Expected, ticks: TickItems[] = [], opts: { hideCheckin?: boolean } = {}): Score {
  let found = 0;
  let total = 0;
  const recall: string[] = [];
  const wrong: string[] = [];
  const placement = { ok: 0, total: 0 };
  const roles = { ok: 0, total: 0 };
  const people = rolePeople(expected);
  for (const d of expected.decisions ?? []) {
    total++;
    const hit = items.find((i) => i.section === "decision" && matches(i.text, d.match));
    if (hit) found++;
    if (d.anchor) {
      placement.total++;
      if (hit?.anchor === d.anchor) placement.ok++;
      else if (hit) wrong.push(`WRONG   ${d.key} placed under ${hit.anchor ?? "–"}, want ${d.anchor}`);
    }
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
    if (a.anchor) {
      placement.total++;
      if (hit?.anchor === a.anchor) placement.ok++;
      else if (hit) wrong.push(`WRONG   ${a.key} placed under ${hit.anchor ?? "–"}, want ${a.anchor}`);
    }
    if (a.ownerLabel) {
      roles.total++;
      const got = hit ? ownerLabel(resolveOwner(hit.owner ?? "", people), hit.owner ?? "", "role") : null;
      if (got === a.ownerLabel) roles.ok++;
      else if (hit) wrong.push(`WRONG   ${a.key} owner shown as "${got}", want "${a.ownerLabel}"`);
    }
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
  const followup = { ok: 0, total: 0 };
  for (const c of expected.carried ?? []) {
    followup.total++;
    const done = Boolean(items.find((i) => i.id === c.id)?.done);
    if (done === c.done) followup.ok++;
    else wrong.push(`WRONG   ${c.id} done=${done}, want ${c.done}`);
  }
  recall.push(...wrong);
  return { found, total, recall, mustNot, mustNotPersistent, mustNotLive, placement, roles, followup, checkinLeaks: checkinLeaks(items, expected, ticks, opts.hideCheckin) };
}

/**
 * Agenda mode: what must never be in the notes. Our carried items (pre-filled, never Claude's)
 * are skipped. The final notes and every live tick are searched: an item under the followup item
 * and, only with Må-runda hiding on (opt-in), an item matching the Må-runda `checkin.match` or
 * under the checkin item. With hiding off (the default) the Må-runda is an ordinary item.
 */
export function checkinLeaks(items: NotesItem[], expected: Expected, ticks: TickItems[] = [], hideCheckin = false): string[] {
  const roleOf = new Map((expected.agenda?.items ?? []).map((a) => [a.key, a.role]));
  const out: string[] = [];
  const seen = new Set<string>();
  const look = (list: NotesItem[], where: string) => {
    for (const i of list) {
      if (i.carried) continue;
      const role = i.anchor ? roleOf.get(i.anchor) : undefined;
      const why =
        hideCheckin && expected.checkin && matches(`${i.text} ${i.owner ?? ""}`, expected.checkin.match)
          ? "Må-runda content"
          : (hideCheckin && role === "checkin") || role === "followup"
            ? `under ${role} item ${i.anchor}`
            : null;
      const key = `${i.id}|${i.text}|${why}`;
      if (!why || seen.has(key)) continue;
      seen.add(key);
      out.push(`${why} (${where})  ← ${i.id} ${itemLine(i)}`);
    }
  };
  look(items, "final");
  ticks.forEach((t, k) => look(t.items, `tick ${k + 1}`));
  return out;
}

/** Whether a score meets the quality bars (cost and churn are checked by the caller). */
export const scorePasses = (s: Score) =>
  s.found === s.total &&
  s.mustNot.length === 0 &&
  s.mustNotPersistent.length === 0 &&
  (s.placement.total === 0 || s.placement.ok / s.placement.total >= 0.9) &&
  s.roles.ok === s.roles.total &&
  s.followup.ok === s.followup.total &&
  s.checkinLeaks.length === 0;

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
  const agendaItems = expected.agenda?.items ?? [];
  if (expected.agenda) {
    const keys = new Set(agendaItems.map((a) => a.key));
    const people = rolePeople(expected);
    for (const [key, anchor] of [...(expected.decisions ?? []), ...(expected.action_items ?? [])].map((x) => [x.key, x.anchor] as const)) {
      if (!anchor) continue;
      if (anchor !== "notes" && !keys.has(anchor)) problems.push(`${key}: anchor ${anchor} is not in agenda.items`);
      const role = agendaItems.find((a) => a.key === anchor)?.role;
      if (role === "checkin" || role === "followup") problems.push(`${key}: anchor ${anchor} is a ${role} item (nothing is placed there)`);
    }
    for (const a of expected.action_items ?? []) {
      if (!a.ownerLabel) continue;
      const got = ownerLabel(resolveOwner(a.owner ?? "", people), a.owner ?? "", "role");
      if (got !== a.ownerLabel) problems.push(`${a.key}: ownerLabel ${a.ownerLabel} but people give "${got}"`);
    }
    const ids = new Set<string>();
    for (const c of expected.carried ?? []) {
      if (!/^c\d+$/.test(c.id) || ids.has(c.id)) problems.push(`carried ${c.id}: id must be a unique c<number>`);
      ids.add(c.id);
      if (!names.includes(c.owner)) problems.push(`carried ${c.id}: owner ${c.owner} not in speakerNames`);
    }
    if (expected.checkin) {
      for (const d of expected.decisions ?? []) if (matches(d.text, expected.checkin.match)) problems.push(`checkin.match hits expected ${d.key}`);
      for (const a of expected.action_items ?? [])
        if (matches(`${a.text} ${a.owner ?? ""}`, expected.checkin.match)) problems.push(`checkin.match hits expected ${a.key}`);
      for (const c of expected.carried ?? []) if (matches(c.text, expected.checkin.match)) problems.push(`checkin.match hits carried ${c.id}`);
    }
  } else if (expected.carried || expected.checkin) problems.push("carried/checkin need an agenda");
  for (const h of expected.human_lines ?? [])
    if (!(expected.must_not ?? []).some((m) => matches(h.line, m.match))) problems.push(`human line "${h.line}" has no must_not guarding a duplicate`);
  return problems;
}
