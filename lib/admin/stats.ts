// The internal dashboard's data (supabase/migrations/0064_admin_dashboard.sql), parsed from the
// two aggregate functions. Counts, dates and org names only.

export type OrgKind = "forening" | "foretag" | "privat";

export interface AdminWeek {
  /** Monday of the week (Europe/Stockholm), YYYY-MM-DD. */
  week: string;
  meetings: number;
  users: number;
}

export interface AdminOverview {
  users: number;
  active7: number;
  active30: number;
  orgs: Record<OrgKind, number>;
  meetings: number;
  meetings7: number;
  minutes30: number;
  weeks: AdminWeek[];
  health: { summaries: number; summaryMails: number; briefs: number; invites: number };
}

export interface AdminOrgRow {
  id: string;
  name: string;
  kind: OrgKind;
  members: number;
  meetings: number;
  lastMeetingAt: string | null;
  createdAt: string;
}

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const KINDS: OrgKind[] = ["forening", "foretag", "privat"];
const kindOf = (v: unknown): OrgKind => (KINDS.includes(v as OrgKind) ? (v as OrgKind) : "forening");

/** admin_overview()'s jsonb → AdminOverview (bigints arrive as numbers or strings). */
export function parseOverview(raw: unknown): AdminOverview {
  const r = (raw ?? {}) as Record<string, unknown>;
  const orgs = (r.orgs ?? {}) as Record<string, unknown>;
  const health = (r.health ?? {}) as Record<string, unknown>;
  const weeks = Array.isArray(r.weeks) ? (r.weeks as Record<string, unknown>[]) : [];
  return {
    users: n(r.users),
    active7: n(r.active7),
    active30: n(r.active30),
    orgs: { forening: n(orgs.forening), foretag: n(orgs.foretag), privat: n(orgs.privat) },
    meetings: n(r.meetings),
    meetings7: n(r.meetings7),
    minutes30: n(r.minutes30),
    weeks: weeks.map((w) => ({ week: String(w.week ?? ""), meetings: n(w.meetings), users: n(w.users) })),
    health: { summaries: n(health.summaries), summaryMails: n(health.summaryMails), briefs: n(health.briefs), invites: n(health.invites) },
  };
}

/** admin_org_stats() rows → AdminOrgRow (only the columns the table shows, plus a row key). */
export function parseOrgRows(raw: unknown): AdminOrgRow[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ""),
    kind: kindOf(r.kind),
    members: n(r.members),
    meetings: n(r.meetings),
    lastMeetingAt: r.last_meeting_at ? String(r.last_meeting_at) : null,
    createdAt: String(r.created_at ?? ""),
  }));
}

export type SortKey = "name" | "kind" | "members" | "meetings" | "lastMeetingAt" | "createdAt";
export type SortDir = "asc" | "desc";

/** Filter by a search text (name, case-insensitive) and a kind, then sort; nulls always last. */
export function filterSortOrgs(rows: AdminOrgRow[], opts: { query: string; kind: OrgKind | "all"; key: SortKey; dir: SortDir }, locale = "sv"): AdminOrgRow[] {
  const q = opts.query.trim().toLocaleLowerCase(locale);
  const kept = rows.filter((r) => (opts.kind === "all" || r.kind === opts.kind) && (!q || r.name.toLocaleLowerCase(locale).includes(q)));
  const sign = opts.dir === "asc" ? 1 : -1;
  return kept.sort((a, b) => {
    const x = a[opts.key];
    const y = b[opts.key];
    if (x === y) return a.name.localeCompare(b.name, locale);
    if (x === null) return 1;
    if (y === null) return -1;
    if (typeof x === "number" && typeof y === "number") return (x - y) * sign;
    return String(x).localeCompare(String(y), locale) * sign;
  });
}

/** ISO 8601 week number of a YYYY-MM-DD date (a calendar date, no time zone). */
export function isoWeek(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

/** A clean axis top for a column chart: at least `max`, one of 1/2/5 × 10^n (never below 4). */
export function niceMax(max: number): number {
  if (max <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10]) if (step * pow >= max) return step * pow;
  return 10 * pow;
}
