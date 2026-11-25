import type { docs_v1 } from "@googleapis/docs";
import fixture from "@/fixtures/agenda/veckomote.doc.json";
import { INITIAL_LIVE_LINE, planAnchoring } from "@/lib/agenda/anchor";
import { scanAgenda } from "@/lib/agenda/scan";
import type { ItemRole, MeetingRow, NoteItemRow } from "@/lib/db/types";
import { planFormatRender } from "@/lib/docs/format-render";
import { renderedRows } from "@/lib/docs/notes";
import { parseNotesTab } from "@/lib/docs/tab";
import type { FormatProfile } from "@/lib/formats/schema";
import { VECKOMOTE } from "@/lib/formats/standard";
import type { NotesItem } from "@/lib/notes/schema";
import { apply, TAB } from "./docsim";

// Format-layout Doc helpers on top of the Docs simulator, shared by tests/meetings/tick.test.ts
// and the feature suite (tests/suite): the A1 agenda fixture anchored as the start leaves it, one
// render as the tick does it, and the Doc read back as lines.

type Doc = docs_v1.Schema$Document;
type Req = docs_v1.Schema$Request;

/** The A1 fixture's roles: ag-1 Godkänn dagordning · ag-2 Må-runda · ag-3 Från förra veckan · ag-4 Kommande event · ag-5 Ekonomi · ag-6 Övrigt. */
export const ROLES = {
  "ag-1": "procedural",
  "ag-2": "checkin",
  "ag-3": "followup",
  "ag-4": "topic",
  "ag-5": "topic",
  "ag-6": "other",
} as const;
export const FMT_STARTED = new Date("2026-11-25T17:05:00Z"); // 18:05 in Stockholm
export const FMT_ENDED = new Date("2026-11-25T18:10:00Z"); // 19:10

export const docText = (doc: Doc) => parseNotesTab(doc, TAB).paragraphs.map((p) => p.text).join("");
export const linesOf = (doc: Doc) => parseNotesTab(doc, TAB).paragraphs.map((p) => p.text.replace(/\n$/, ""));

/** docsim's apply, plus replaceNamedRangeContent (delete the range's text, insert, re-create the range); bumps the revision. */
export function applyDoc(doc: Doc, requests: Req[]): Doc {
  for (const r of requests) {
    const rep = r.replaceNamedRangeContent;
    if (!rep) {
      apply(doc, [r]);
      continue;
    }
    const name = rep.namedRangeName!;
    const parts = (parseNotesTab(doc, TAB).ranges.get(name) ?? []).flat().filter((x) => x.end > x.start);
    if (parts.length !== 1) throw new Error(`replace ${name}: ${parts.length} parts`);
    const { start, end } = parts[0];
    const text = rep.text ?? "";
    apply(doc, [
      { deleteContentRange: { range: { tabId: TAB, startIndex: start, endIndex: end } } },
      { insertText: { text, location: { tabId: TAB, index: start } } },
      { deleteNamedRange: { name, tabsCriteria: { tabIds: [TAB] } } },
      { createNamedRange: { name, range: { tabId: TAB, startIndex: start, endIndex: start + text.length } } },
    ]);
  }
  doc.revisionId = `REV_${Number(String(doc.revisionId ?? "").replace(/\D/g, "") || 0) + 1}`;
  return doc;
}

/** A fresh copy of the A1 agenda fixture Doc. */
export const fixtureDoc = (): Doc => JSON.parse(JSON.stringify(fixture)) as Doc;

/** An agenda Doc (default: the A1 fixture) as the start leaves it for meeting `id` (anchors, LIVE line, Tid "18:05"). */
export function anchoredDoc(id: string, opts: { doc?: Doc; profile?: FormatProfile; startedAt?: Date } = {}) {
  const doc = opts.doc ?? fixtureDoc();
  const profile = opts.profile ?? VECKOMOTE;
  const tab = parseNotesTab(doc, TAB);
  const plan = planAnchoring(scanAgenda(tab, profile), tab, { meetingId: id, profile, startedAt: opts.startedAt ?? FMT_STARTED });
  applyDoc(doc, plan.requests);
  return { doc, plan };
}

export function fmtMeeting(
  id: string,
  plan: { headerRange: string; sectionRanges: Record<string, string> },
  over: Partial<MeetingRow> & { agenda_roles?: Record<string, ItemRole> } = {},
): MeetingRow {
  return {
    id,
    org_id: "o",
    notes_tab_id: TAB,
    header_range: plan.headerRange,
    header_rendered: INITIAL_LIVE_LINE,
    section_ranges: plan.sectionRanges,
    agenda_roles: { ...ROLES },
    layout: "format",
    started_at: FMT_STARTED.toISOString(),
    ...over,
  } as MeetingRow;
}

/** One render as the tick does it (planFormatRender), applied to the simulated Doc. */
export function renderInto(
  doc: Doc,
  meeting: MeetingRow,
  rows: NoteItemRow[],
  desired: NotesItem[],
  opts: {
    header?: string;
    newAnchors?: { key: string; start: number; end: number }[];
    profile?: FormatProfile;
    ownerLabel?: (owner: string) => string;
  } = {},
) {
  const tab = parseNotesTab(doc, TAB);
  const plan = planFormatRender(meeting, tab, rows, desired, {
    profile: opts.profile ?? VECKOMOTE,
    ownerLabel: opts.ownerLabel ?? ((o) => o),
    headerText: opts.header,
    newAnchors: opts.newAnchors,
  });
  applyDoc(doc, plan.requests);
  return { rows: renderedRows(meeting.id, rows, desired, plan), plan };
}

/** Insert a new top-level agenda item right before "Övrigt" (inherits its list and level). */
export function insertItemBeforeOvrigt(doc: Doc, label: string) {
  const ovrigt = parseNotesTab(doc, TAB).paragraphs.find((p) => p.text === "Övrigt\n")!;
  applyDoc(doc, [{ insertText: { text: `${label}\n`, location: { tabId: TAB, index: ovrigt.start } } }]);
}
