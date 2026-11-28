import { z } from "zod";

// "Vad Claude ska veta" (docs/superpowers/specs/2026-11-28-claude-tasks-memory-design.md, B): one
// admin-curated page per org, built by Claude from meetings every member can see, each line with
// its sources. Pure: the lines' shape, the merge after Uppdatera, the admins' edits and the read
// filter (a line with sources only for a reader who can see all of them).

export const MEMORY_SECTIONS = ["customers", "priorities", "decisions", "glossary", "people"] as const;
export type MemorySection = (typeof MEMORY_SECTIONS)[number];

export const MAX_LINE = 300;
export const MAX_SOURCES = 10;
export const MAX_PER_SECTION = 15;
export const MAX_LINES = 200;
/** Uppdatera reads at most this many meetings, newest first. */
export const MEMORY_MEETINGS = 40;
/** One Uppdatera per org per this many seconds. */
export const MEMORY_COOLDOWN_S = 60;

export interface MemoryLine {
  id: string;
  section: MemorySection;
  text: string;
  /** Meeting ids the line is based on (empty: written by an admin). */
  sources: string[];
  /** An admin wrote or changed it: Uppdatera never touches it. */
  edited: boolean;
  /**
   * An attributed line (generated after 2026-11-28): the meeting it was said in (one of
   * `sources`). The page and get_org_memory render it as "<speaker> sa i mötet <date>: <text>".
   * Absent on older generated lines ("Från mötet <date>: …") and on an admin's own lines.
   */
  saidIn?: string;
  /** Who said it: a task owner in `saidIn` (checked by the server, never invented). Absent: unknown. */
  speaker?: string;
  /** The admin who wrote or last changed the line ("Tillagt av <admin>"); absent when not known. */
  addedBy?: string;
}

/** Longest speaker or admin name kept. */
export const MAX_NAME = 80;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINE_ID = /^[A-Za-z0-9_-]{1,40}$/;

export const clean = (s: string | null | undefined) => (s ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
const same = (a: string, b: string) => clean(a).toLocaleLowerCase("sv") === clean(b).toLocaleLowerCase("sv");

const isSection = (v: unknown): v is MemorySection => typeof v === "string" && (MEMORY_SECTIONS as readonly string[]).includes(v);

/** The stored lines (org_memory.lines), every bad one dropped. */
export function parseLines(raw: unknown): MemoryLine[] {
  if (!Array.isArray(raw)) return [];
  const out: MemoryLine[] = [];
  const seen = new Set<string>();
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue;
    const text = clean(typeof r.text === "string" ? r.text : "");
    if (typeof r.id !== "string" || !LINE_ID.test(r.id) || seen.has(r.id) || !isSection(r.section) || !text || text.length > MAX_LINE) continue;
    seen.add(r.id);
    const sources = Array.isArray(r.sources) ? [...new Set(r.sources.filter((s): s is string => typeof s === "string" && UUID.test(s)))].slice(0, MAX_SOURCES) : [];
    const line: MemoryLine = { id: r.id, section: r.section, text, sources, edited: r.edited === true };
    const name = (v: unknown) => {
      const n = clean(typeof v === "string" ? v : "");
      return n && n.length <= MAX_NAME ? n : null;
    };
    // Who said it only holds for the text as Claude wrote it: never on an admin's line.
    if (!line.edited && typeof r.saidIn === "string" && sources.includes(r.saidIn)) {
      line.saidIn = r.saidIn;
      const speaker = name(r.speaker);
      if (speaker) line.speaker = speaker;
    }
    const by = line.edited ? name(r.addedBy) : null;
    if (by) line.addedBy = by;
    out.push(line);
  }
  return out.slice(0, MAX_LINES);
}

/** What Claude returns for Uppdatera (structured output). */
export const GeneratedSchema = z.object({
  lines: z.array(z.object({ section: z.enum(MEMORY_SECTIONS), text: z.string(), sources: z.array(z.string()), speaker: z.string().optional() })),
});
export type Generated = z.infer<typeof GeneratedSchema>;

export const GENERATED_JSON_SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          section: { type: "string", enum: [...MEMORY_SECTIONS] },
          text: { type: "string" },
          sources: { type: "array", items: { type: "string" } },
          speaker: { type: "string" },
        },
        required: ["section", "text", "sources", "speaker"],
        additionalProperties: false,
      },
    },
  },
  required: ["lines"],
  additionalProperties: false,
} as const;

/**
 * After Uppdatera: every line an admin wrote or changed stays as it is (first); Claude's lines
 * replace the earlier generated ones. A generated line keeps only sources from `allowed` (the
 * meetings it was sent) and is dropped without one, when too long, or when it repeats a kept line.
 * Its first allowed source is the meeting it was said in (`saidIn`). Its speaker is kept only when
 * it is a task owner of that very meeting (`owners`, from the meeting data, never Claude): a name
 * Claude made up, or one from another meeting, becomes "Sades i mötet" (unknown speaker).
 */
export function mergeGenerated(
  existing: MemoryLine[],
  generated: Generated,
  allowed: Set<string>,
  newId: () => string,
  owners: Map<string, string[]> = new Map(),
): MemoryLine[] {
  const kept = existing.filter((l) => l.edited);
  const out: MemoryLine[] = [...kept];
  const count = new Map<MemorySection, number>();
  for (const l of kept) count.set(l.section, (count.get(l.section) ?? 0) + 1);
  for (const g of generated.lines) {
    const text = clean(g.text);
    if (!text || text.length > MAX_LINE) continue;
    const sources = [...new Set(g.sources.map((s) => s.trim().toLowerCase()).filter((s) => allowed.has(s)))].slice(0, MAX_SOURCES);
    if (!sources.length) continue;
    if (out.some((l) => same(l.text, text))) continue;
    if ((count.get(g.section) ?? 0) >= MAX_PER_SECTION) continue;
    count.set(g.section, (count.get(g.section) ?? 0) + 1);
    const saidIn = sources[0];
    const speaker = clean(g.speaker) ? (owners.get(saidIn) ?? []).find((o) => same(o, g.speaker ?? "")) : undefined;
    out.push({ id: newId(), section: g.section, text, sources, edited: false, saidIn, ...(speaker && speaker.length <= MAX_NAME ? { speaker } : {}) });
  }
  return out.slice(0, MAX_LINES);
}

/** An admin's edit of the page: the lines as submitted (id, section, text; never sources). */
export interface EditedLine {
  id?: string | null;
  section: string;
  text: string;
}

/**
 * The admin's save: lines they removed go, a changed one is marked edited (its sources stay: they
 * are the server's, never the form's) and loses who said it (the text is now the admin's), a new
 * one has no sources. Both get `author` ("Tillagt av <admin>", the server's, never the form's).
 * Null when the edit is invalid.
 */
export function applyEdits(existing: MemoryLine[], edits: EditedLine[], newId: () => string, author: string | null = null): MemoryLine[] | null {
  if (!Array.isArray(edits) || edits.length > MAX_LINES) return null;
  const byId = new Map(existing.map((l) => [l.id, l]));
  const out: MemoryLine[] = [];
  const used = new Set<string>();
  const by = clean(author);
  const stamp = by && by.length <= MAX_NAME ? { addedBy: by } : {};
  for (const e of edits) {
    if (!e || typeof e !== "object" || !isSection(e.section) || typeof e.text !== "string") return null;
    const text = clean(e.text);
    if (text.length > MAX_LINE) return null;
    if (!text) continue;
    // An id must name a line that is there, once: never a new line made from an old one.
    if (typeof e.id === "string" && (!byId.has(e.id) || used.has(e.id))) return null;
    const before = typeof e.id === "string" ? byId.get(e.id) : undefined;
    if (before) {
      used.add(before.id);
      const changed = before.text !== text || before.section !== e.section;
      if (!changed) {
        out.push(before);
        continue;
      }
      const { saidIn: _s, speaker: _p, addedBy: _a, ...rest } = before;
      out.push({ ...rest, section: e.section, text, edited: true, ...stamp });
    } else {
      out.push({ id: newId(), section: e.section, text, sources: [], edited: true, ...stamp });
    }
  }
  return out;
}

/** The lines a reader may see: a line with sources only when they can see every one of them. */
export function visibleLines(lines: MemoryLine[], canSee: Set<string>): MemoryLine[] {
  return lines.filter((l) => l.sources.every((s) => canSee.has(s)));
}

export const allSources = (lines: MemoryLine[]) => [...new Set(lines.flatMap((l) => l.sources))];

export function newLineId(): string {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
