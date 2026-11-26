import type { NoteItemRow } from "@/lib/db/types";
import type { NotesTab } from "@/lib/docs/tab";
import type { FormatProfile } from "@/lib/formats/schema";
import type { DocsRequest } from "@/lib/google/docs";
import { followupKey, planCarried, planInsert, planReconcile, planReprepare, prepMeeting, type DocLine, type ReprepareMode } from "./doc";
import type { DraftItem } from "./draft";

// Preparing again, step by step. Each step is one revision-guarded batch planned from a fresh read
// (`step`), and what it changed in the Doc is saved right after it (`save`), so a failure between
// steps never leaves stored lines that no longer match the Doc (they would read as human edits:
// frozen items, carried tasks taken for deleted and never carried again). A step that wrote but
// whose save failed is reconciled on the next run (planReconcile). No Google or database code
// here: the route passes both in, the tests pass the Docs simulator.

export interface ReprepareDeps {
  /** One guarded batch: plan from a fresh read, write, return the plan's value. */
  step<T>(plan: (tab: NotesTab) => { requests: DocsRequest[]; value: T }): Promise<T>;
  /** Persist what the Doc now holds. */
  save(patch: { doc_lines?: DocLine[]; carried?: NoteItemRow[] }): Promise<void>;
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
    items: DraftItem[];
    /** The carried rows wanted (carriedItems, anchor unset). */
    desired: NoteItemRow[];
  },
): Promise<{ mode: ReprepareMode; lines: DocLine[]; carried: NoteItemRow[]; inserts: number }> {
  const { key, profile, items } = input;
  let carried = input.carried;
  let lines = await deps.step((tab) => {
    const r = planReconcile(tab, profile, key, input.lines, carried, items);
    return { requests: r.requests, value: r.lines };
  });
  if (lines.length !== input.lines.length) await deps.save({ doc_lines: lines });

  const step1 = await deps.step((tab) => {
    const p = planReprepare(tab, profile, key, lines, carried, items);
    return { requests: p.requests, value: p };
  });
  lines = step1.lines;
  if (step1.mode === "rewrite") {
    // Our carried lines went with the region: only human deletions are remembered.
    carried = carried.filter((r) => r.deleted_by_human).map((r) => ({ ...r, range_name: null }));
  }
  await deps.save({ doc_lines: lines, carried });

  for (const id of step1.inserts) {
    const placed = await deps.step((tab) => {
      const ins = planInsert(tab, profile, key, lines, items, id);
      return { requests: ins?.requests ?? [], value: ins?.line ?? null };
    });
    if (!placed) continue;
    lines = [...lines, placed];
    await deps.save({ doc_lines: lines });
  }

  carried = await deps.step((tab) => {
    const fk = followupKey(tab, lines, items);
    const meeting = prepMeeting(key, input.docId, input.tabId, lines, items);
    const want = fk ? input.desired.map((r) => ({ ...r, anchor: fk })) : [];
    const { plan, rows } = planCarried(tab, meeting, carried, want, { profile, ownerLabel: input.ownerLabel, rewritten: false });
    return { requests: plan.requests, value: rows };
  });
  await deps.save({ carried });
  return { mode: step1.mode, lines, carried, inserts: step1.inserts.length };
}
