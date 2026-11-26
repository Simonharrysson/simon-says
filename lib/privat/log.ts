// What a context page "keeps track of" across recordings, from the stored summaries (0045). Pure.

export interface SummaryForLog {
  meeting_id: string;
  created_at: string;
  /** When the recording started (the log is dated by it). */
  started_at: string;
  decisions: string[];
  facts: string[];
  people: string[];
  topics: string[];
}

export interface LogEntry {
  kind: "decision" | "fact";
  text: string;
  meetingId: string;
  at: string;
}

/** Decisions and key facts, newest recording first, each text once (its latest mention). */
export function decisionLog(summaries: SummaryForLog[], max = 40): LogEntry[] {
  const seen = new Set<string>();
  const out: LogEntry[] = [];
  const newest = [...summaries].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  for (const s of newest) {
    for (const [kind, texts] of [
      ["decision", s.decisions],
      ["fact", s.facts],
    ] as const) {
      for (const text of texts) {
        const key = `${kind}:${text.trim().toLocaleLowerCase("sv-SE")}`;
        if (!text.trim() || seen.has(key)) continue;
        seen.add(key);
        out.push({ kind, text: text.trim(), meetingId: s.meeting_id, at: s.started_at });
      }
    }
  }
  return out.slice(0, max);
}

export interface Recurring {
  name: string;
  /** In how many recordings. */
  count: number;
}

/**
 * People and topics that come back: named in at least `min` recordings (default 2), most
 * frequent first, then most recent. Case-insensitive; shown as last spelled.
 */
export function recurring(summaries: SummaryForLog[], field: "people" | "topics", min = 2, max = 8): Recurring[] {
  const byKey = new Map<string, { name: string; count: number; last: number }>();
  for (const s of [...summaries].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))) {
    const at = Date.parse(s.started_at);
    for (const raw of new Set(s[field].map((x) => x.trim()).filter(Boolean))) {
      const key = raw.toLocaleLowerCase("sv-SE");
      const cur = byKey.get(key);
      byKey.set(key, { name: raw, count: (cur?.count ?? 0) + 1, last: at });
    }
  }
  return [...byKey.values()]
    .filter((r) => r.count >= min)
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .slice(0, max)
    .map(({ name, count }) => ({ name, count }));
}

/** The first sentence of a summary, for lists. */
export function firstSentence(text: string, max = 160): string {
  const t = text.trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  const s = m ? m[1] : t;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}
