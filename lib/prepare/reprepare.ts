import type { NoteItemRow } from "@/lib/db/types";
import { itemRangeName } from "@/lib/docs/notes";
import type { NotesTab } from "@/lib/docs/tab";
import type { FormatProfile } from "@/lib/formats/schema";
import type { DocsRequest } from "@/lib/google/docs";
import { followupKey, planCarried, planInsert, planReconcile, planReprepare, prepMeeting, type DocLine, type Journal, type ReprepareMode } from "./doc";
import type { DraftItem } from "./draft";

// Preparing again, step by step, crash-safe. Each step is one revision-guarded batch planned from
// a fresh read. Before the batch goes out, its journal (the ranges it writes with the exact text,
// the ranges it deletes) is saved; after it, what the Doc now holds is saved and the journal
// cleared. Every run writes ranges under a new generation (`g<gen>`), so a name is never reused.
// The next run settles a journal left behind (planReconcile): a batch written but not saved is
// recognised by its exact text, never taken for human edits, and nothing a human wrote is deleted.
// No Google or database code here: the route passes both in, the tests pass the Docs simulator.

export interface Saved {
  doc_lines?: DocLine[];
  carried?: NoteItemRow[];
  journal?: Journal | null;
  gen?: number;
}

export interface ReprepareDeps {
  /** One guarded batch: plan from a fresh read, `before(planned)` (the journal is saved there), write, return the value. */
  step<T>(plan: (tab: NotesTab) => { requests: DocsRequest[]; value: T; journal: Journal }, before: (journal: Journal) => Promise<void>): Promise<T>;
  /** Persist (the caller holds the prepared agenda's lease). */
  save(patch: Saved): Promise<void>;
}

export async function runReprepare(
  deps: ReprepareDeps,
  input: {
    key: string;
    docId: string;
    tabId: string;
    profile: FormatProfile;
    ownerLabel: (owner: string) => string;
    lines: DocLine[];
    carried: NoteItemRow[];
    /** The journal a failed run left (null: none). */
    journal: Journal | null;
    /** The last generation used. */
    gen: number;
    items: DraftItem[];
    /** The carried rows wanted (carriedItems, anchor unset). */
    desired: NoteItemRow[];
  },
): Promise<{ mode: ReprepareMode; lines: DocLine[]; carried: NoteItemRow[]; inserts: number }> {
  const { key, profile, items } = input;
  const gen = input.gen + 1;
  await deps.save({ gen });
  const journaled = (journal: Journal) => deps.save({ journal });

  // 0. Settle what the last run may have left.
  const settled = await deps.step((tab) => {
    const r = planReconcile(tab, key, input.lines, input.carried, input.journal);
    return { requests: r.requests, value: r, journal: { writes: [], deletes: [] } };
  }, journaled);
  let lines = settled.lines;
  let carried = settled.carried;
  await deps.save({ doc_lines: lines, carried, journal: null });

  // 1. Items: rewrite or merge.
  const step1 = await deps.step((tab) => {
    const p = planReprepare(tab, profile, key, lines, carried, items, gen);
    return { requests: p.requests, value: p, journal: p.journal };
  }, journaled);
  lines = step1.lines;
  // A rewrite removed our carried lines with the region: only human deletions are remembered.
  if (step1.mode === "rewrite") carried = carried.filter((r) => r.deleted_by_human).map((r) => ({ ...r, range_name: null }));
  await deps.save({ doc_lines: lines, carried, journal: null });

  // 2. New items (merge), one batch each.
  for (const id of step1.inserts) {
    const placed = await deps.step((tab) => {
      const ins = planInsert(tab, profile, key, lines, items, id, gen);
      return { requests: ins?.requests ?? [], value: ins?.line ?? null, journal: { writes: ins ? [{ range: ins.line.range, text: ins.line.text, id }] : [], deletes: [] } };
    }, journaled);
    if (!placed) continue;
    lines = [...lines, placed];
    await deps.save({ doc_lines: lines, journal: null });
  }

  // 3. Från förra veckan, by the notes engine (new ranges under this run's generation).
  carried = await deps.step((tab) => {
    const fk = followupKey(tab, lines, items);
    const meeting = prepMeeting(`${key}-g${gen}`, input.docId, input.tabId, lines, items);
    const want = fk ? input.desired.map((r) => ({ ...r, anchor: fk })) : [];
    const { plan, rows } = planCarried(tab, meeting, carried, want, { profile, ownerLabel: input.ownerLabel, rewritten: false });
    const byId = new Map(carried.map((r) => [r.id, r]));
    const journal: Journal = {
      writes: rows
        .filter((r) => plan.applied.has(r.id) && r.last_rendered_text != null)
        .map((r) => ({
          range: r.range_name ?? itemRangeName(meeting.id, r.id),
          text: r.last_rendered_text!,
          ...(byId.get(r.id)?.range_name ? {} : { row: r }),
        })),
      deletes: [...plan.removed].map((id) => byId.get(id)?.range_name).filter((x): x is string => Boolean(x)),
    };
    return { requests: plan.requests, value: rows, journal };
  }, journaled);
  await deps.save({ carried, journal: null });
  return { mode: step1.mode, lines, carried, inserts: step1.inserts.length };
}
