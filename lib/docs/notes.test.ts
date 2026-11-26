import type { docs_v1 } from "@googleapis/docs";
import type { OAuth2Client } from "google-auth-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingRow, NoteItemRow } from "@/lib/db/types";
import type { NotesItem } from "@/lib/notes/schema";

const api = vi.hoisted(() => ({ get: vi.fn(), batchUpdate: vi.fn() }));
vi.mock("@/lib/google/docs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/docs")>()),
  docsApi: () => ({ documents: { get: api.get, batchUpdate: api.batchUpdate } }),
}));

import {
  diffHumanEdits,
  formatItem,
  itemRangeName,
  parseNotesTab,
  planRender,
  readItems,
  renderedRows,
  renderItems,
  toNotesItem,
} from "./notes";

const auth = {} as OAuth2Client;
const TAB = "t.0";
const M = "m1";
const conflict = () =>
  Object.assign(new Error("The required revision ID 'r' does not match the latest revision."), { status: 400 });

/**
 * A `documents.get` response for one tab, in the shape the real API returns (see the Task 2 Doc:
 * sectionBreak at 0, one paragraph per line with a textRun, namedRanges without tabId).
 * Ranges are marked in `text` with `{name}…{/name}`; a range may cross "\n" (Enter inside it).
 * A second `{name@2}…{/name@2}` pair makes a second named range with the same name.
 */
function docJson(text: string, revisionId = "rev1"): docs_v1.Schema$Document {
  const open = new Map<string, number>();
  const ranges = new Map<string, Map<string, { startIndex: number; endIndex: number }[]>>();
  let plain = "";
  for (let i = 0; i < text.length; ) {
    const m = /^\{(\/?)([^{}@]+)(?:@(\d+))?\}/.exec(text.slice(i));
    if (m) {
      const key = `${m[2]}@${m[3] ?? "1"}`;
      if (!m[1]) open.set(key, plain.length + 1);
      else {
        const byEntry = ranges.get(m[2]) ?? new Map();
        const parts = byEntry.get(key) ?? [];
        parts.push({ startIndex: open.get(key)!, endIndex: plain.length + 1 });
        byEntry.set(key, parts);
        ranges.set(m[2], byEntry);
      }
      i += m[0].length;
    } else plain += text[i++];
  }
  const content: docs_v1.Schema$StructuralElement[] = [{ endIndex: 1, sectionBreak: {} }];
  let index = 1;
  for (const line of plain.split("\n")) {
    const len = line.length + 1;
    content.push({
      startIndex: index,
      endIndex: index + len,
      paragraph: {
        elements: [{ startIndex: index, endIndex: index + len, textRun: { content: `${line}\n`, textStyle: {} } }],
        paragraphStyle: { namedStyleType: "NORMAL_TEXT", direction: "LEFT_TO_RIGHT" },
      },
    });
    index += len;
  }
  const namedRanges: Record<string, docs_v1.Schema$NamedRanges> = {};
  for (const [name, byEntry] of ranges) {
    namedRanges[name] = {
      name,
      namedRanges: [...byEntry.values()].map((parts, k) => ({ name, namedRangeId: `kix.${name}.${k}`, ranges: parts })),
    };
  }
  return {
    documentId: "doc1",
    revisionId,
    tabs: [{ tabProperties: { tabId: TAB, title: "Anteckningar" }, documentTab: { body: { content }, namedRanges } }],
  };
}

const meeting: MeetingRow = {
  id: M,
  org_id: "o1",
  started_by: null,
  doc_id: "doc1",
  notes_tab_id: TAB,
  transcript_tab_id: null,
  header_range: `ss-${M}-header`,
  header_rendered: "LIVE · uppdaterad 10:00",
  section_ranges: {
    attendees: `ss-${M}-sec-attendees`,
    decision: `ss-${M}-sec-decision`,
    action: `ss-${M}-sec-action`,
    now: `ss-${M}-sec-now`,
  },
  status: "live",
  consent_confirmed_at: null,
  started_at: "2026-11-24T10:00:00Z",
  ended_at: null,
  last_heartbeat_at: null,
  last_tick_at: null,
  last_tick_ok_at: null,
  failed_ticks: 0,
  tick_lease_until: null,
  doc_paused_at: null,
  current_el_session_id: null,
};

function row(id: string, section: NoteItemRow["section"], text: string, extra: Partial<NoteItemRow> = {}): NoteItemRow {
  const owner = extra.owner ?? null;
  const due = extra.due ?? null;
  return {
    meeting_id: M,
    id,
    section,
    text,
    owner,
    due,
    locked: false,
    deleted_by_human: false,
    last_rendered_text: formatItem({ section, text, owner: owner ?? undefined, due: due ?? undefined }),
    range_name: itemRangeName(M, id),
    position: 0,
    ...extra,
  };
}

const rows = (): NoteItemRow[] => [
  row("n1", "decision", "Hackathon 14 feb"),
  row("n2", "action", "boka lokal", { owner: "Simon", due: "fre" }),
  row("n3", "action", "budget", { owner: "Anna", position: 1 }),
  row("n4", "now", "Diskussion om sponsorer"),
];
const desiredFrom = (rs: NoteItemRow[]): NotesItem[] => rs.map(toNotesItem);

const H = `{ss-m1-header}LIVE · uppdaterad 10:00{/ss-m1-header}`;
const SEC = (s: string, title: string) => `{ss-m1-sec-${s}}${title}{/ss-m1-sec-${s}}`;
const R = (id: string, text: string) => `{ss-m1-${id}}${text}{/ss-m1-${id}}`;

/** The notes tab as we rendered it, optionally with lines replaced (by index) to simulate human edits. */
function tabText(edit: Record<number, string> = {}): string {
  const lines = [
    H,
    SEC("attendees", "Närvarande"),
    SEC("decision", "Beslut"),
    R("n1", "✓ Hackathon 14 feb"),
    SEC("action", "Att göra"),
    R("n2", "☐ Simon: boka lokal (fre)"),
    R("n3", "☐ Anna: budget"),
    SEC("now", "Pågår nu"),
    R("n4", "Diskussion om sponsorer"),
  ];
  return lines.map((l, i) => (i in edit ? edit[i] : l)).join("\n");
}

async function read(text: string, rs = rows()) {
  api.get.mockResolvedValueOnce({ data: docJson(text) });
  return readItems(auth, "doc1", TAB, rs);
}

beforeEach(() => {
  api.get.mockReset();
  api.batchUpdate.mockReset();
});

describe("formatItem", () => {
  it("formats actions and decisions", () => {
    expect(formatItem({ section: "action", text: "boka lokal", owner: "Simon", due: "fre" })).toBe("☐ Simon: boka lokal (fre)");
    expect(formatItem({ section: "action", text: "boka lokal" })).toBe("☐ boka lokal");
    expect(formatItem({ section: "decision", text: "Hackathon 14 feb" })).toBe("✓ Hackathon 14 feb");
    expect(formatItem({ section: "now", text: "Sponsorer" })).toBe("Sponsorer");
  });

  it("never produces a newline or control character (they would become permanent false locks)", () => {
    expect(formatItem({ section: "decision", text: " a\nb\u000bc\t d\u2028e  " })).toBe("✓ a b c d e");
  });
});

describe("readItems", () => {
  it("returns each item's paragraph text and the revision", async () => {
    const { revisionId, current } = await read(tabText());
    expect(revisionId).toBe("rev1");
    expect(current).toEqual(
      new Map([
        ["n1", "✓ Hackathon 14 feb"],
        ["n2", "☐ Simon: boka lokal (fre)"],
        ["n3", "☐ Anna: budget"],
        ["n4", "Diskussion om sponsorer"],
      ]),
    );
    expect(api.get).toHaveBeenCalledWith({ documentId: "doc1", includeTabsContent: true, suggestionsViewMode: "SUGGESTIONS_INLINE" });
  });

  it("reads the whole paragraph, including text typed just outside the range", async () => {
    const { current } = await read(tabText({ 5: `Viktigt: ${R("n2", "☐ Simon: boka lokal (fre)")} !!` }));
    expect(current.get("n2")).toBe("Viktigt: ☐ Simon: boka lokal (fre) !!");
  });

  it("reads every paragraph a range spans after Enter inside it", async () => {
    const { current } = await read(tabText({ 5: R("n2", "☐ Simon: boka\nlokal (fre)") }));
    expect(current.get("n2")).toBe("☐ Simon: boka\nlokal (fre)");
  });

  it("returns null for a range that is gone or empty", async () => {
    const { current } = await read(tabText({ 6: "", 3: "{ss-m1-n1}{/ss-m1-n1}" }));
    expect(current.get("n3")).toBeNull();
    expect(current.get("n1")).toBeNull();
  });

  it("skips rows never rendered and rows already deleted by a human", async () => {
    const rs = [...rows(), row("n9", "action", "ny", { range_name: null, last_rendered_text: null })];
    rs[0] = { ...rs[0], deleted_by_human: true };
    const { current } = await read(tabText(), rs);
    expect(current.has("n9")).toBe(false);
    expect(current.has("n1")).toBe(false);
  });
});

describe("diffHumanEdits", () => {
  const diff = async (text: string, rs = rows()) => diffHumanEdits(rs, (await read(text, rs)).current);

  it("unchanged items → nothing locked or deleted", async () => {
    const d = await diff(tabText());
    expect(d.locked).toEqual([]);
    expect(d.deletedIds).toEqual([]);
    expect(d.rows).toEqual(rows());
  });

  it("text edited inside a range → locked with the human text", async () => {
    const d = await diff(tabText({ 5: R("n2", "☐ Simon: boka STOR lokal (fre)") }));
    expect(d.locked).toEqual([{ id: "n2", section: "action", text: "☐ Simon: boka STOR lokal (fre)" }]);
    expect(d.rows.find((r) => r.id === "n2")).toMatchObject({ locked: true, text: "☐ Simon: boka STOR lokal (fre)" });
  });

  it("text typed just before or just after a range (outside it) → locked", async () => {
    const before = await diff(tabText({ 3: `OBS ${R("n1", "✓ Hackathon 14 feb")}` }));
    expect(before.locked).toEqual([{ id: "n1", section: "decision", text: "OBS ✓ Hackathon 14 feb" }]);
    const after = await diff(tabText({ 3: `${R("n1", "✓ Hackathon 14 feb")}, i Kårallen` }));
    expect(after.locked).toEqual([{ id: "n1", section: "decision", text: "✓ Hackathon 14 feb, i Kårallen" }]);
  });

  it("Enter inside a range (one range over two paragraphs) → locked with both paragraphs", async () => {
    const d = await diff(tabText({ 5: R("n2", "☐ Simon: boka\nlokal (fre)") }));
    expect(d.locked).toEqual([{ id: "n2", section: "action", text: "☐ Simon: boka\nlokal (fre)" }]);
  });

  it("an embedded object (chip, image) in the paragraph → locked", async () => {
    const doc = docJson(tabText());
    const para = doc.tabs![0].documentTab!.body!.content!.find((c) => c.paragraph?.elements?.[0].textRun?.content?.startsWith("✓"))!;
    const end = para.endIndex!;
    para.endIndex = end + 1;
    para.paragraph!.elements!.push({ startIndex: end, endIndex: end + 1, inlineObjectElement: { inlineObjectId: "x" } });
    api.get.mockResolvedValueOnce({ data: doc });
    const { current: cur } = await readItems(auth, "doc1", TAB, rows());
    expect(diffHumanEdits(rows(), cur).locked.map((l) => l.id)).toContain("n1");
  });

  it("two ranges with the same name (copy-paste) → locked", async () => {
    const d = await diff(tabText({ 6: `${R("n3", "☐ Anna: budget")}\n{ss-m1-n3@2}☐ Anna: budget{/ss-m1-n3@2}` }));
    expect(d.locked.map((l) => l.id)).toEqual(["n3"]);
  });

  it("deleted range → deleted_by_human and in deletedIds (and stays so)", async () => {
    const d = await diff(tabText({ 6: "" }));
    expect(d.deletedIds).toEqual(["n3"]);
    expect(d.rows.find((r) => r.id === "n3")).toMatchObject({ deleted_by_human: true });
    const again = diffHumanEdits(d.rows, new Map());
    expect(again.deletedIds).toEqual(["n3"]);
  });

  it("already-locked items stay locked, text refreshed from the Doc", async () => {
    const rs = rows();
    rs[0] = { ...rs[0], locked: true, text: "gammal" };
    const d = await diff(tabText(), rs);
    expect(d.locked).toEqual([{ id: "n1", section: "decision", text: "✓ Hackathon 14 feb" }]);
  });

  it("the 'now' item is never locked", async () => {
    const d = await diff(tabText({ 8: R("n4", "Diskussion om något annat") }));
    expect(d.locked).toEqual([]);
    expect(d.rows.find((r) => r.id === "n4")?.locked).toBe(false);
  });

  it("rows not rendered yet are left alone", () => {
    const pending = row("n9", "action", "ny", { range_name: null, last_rendered_text: null });
    expect(diffHumanEdits([pending], new Map())).toEqual({ locked: [], deletedIds: [], rows: [pending] });
  });
});

/** Read, diff and render like a tick does; returns the batchUpdate request body (or null). */
async function tick(
  text: string | docs_v1.Schema$Document,
  desired: (rs: NoteItemRow[]) => NotesItem[],
  headerText?: string,
  opts: { rows?: NoteItemRow[]; meeting?: MeetingRow; diff?: boolean } = {},
) {
  const base = opts.rows ?? rows();
  api.get.mockResolvedValueOnce({ data: typeof text === "string" ? docJson(text) : text });
  const { revisionId, current, suggested } = await readItems(auth, "doc1", TAB, base);
  const rs = opts.diff === false ? base : diffHumanEdits(base, current, suggested).rows;
  api.batchUpdate.mockResolvedValueOnce({ data: {} });
  const res = await renderItems(auth, opts.meeting ?? meeting, rs, desired(rs), revisionId, headerText);
  const body = api.batchUpdate.mock.calls[0]?.[0]?.requestBody ?? null;
  return { res, result: res.status, body, requests: (body?.requests ?? []) as docs_v1.Schema$Request[] };
}

/** Mark the first paragraph starting with `prefix` as carrying a pending suggestion. */
function withSuggestion(doc: docs_v1.Schema$Document, prefix: string, kind: "suggestedInsertionIds" | "suggestedDeletionIds") {
  const para = doc.tabs![0].documentTab!.body!.content!.find((c) => c.paragraph?.elements?.[0].textRun?.content?.startsWith(prefix))!;
  para.paragraph!.elements![0].textRun![kind] = ["suggest.abc"];
  return doc;
}

const tabIdsOf = (r: docs_v1.Schema$Request): string[] => {
  const ids: (string | null | undefined)[] = [
    r.insertText?.location?.tabId,
    r.createNamedRange?.range?.tabId,
    r.deleteContentRange?.range?.tabId,
    r.updateParagraphStyle?.range?.tabId,
    ...(r.replaceNamedRangeContent?.tabsCriteria?.tabIds ?? []),
    ...(r.deleteNamedRange?.tabsCriteria?.tabIds ?? []),
  ];
  return ids.filter((x): x is string => !!x);
};

/** Indices of the requests that move text: these must run from the highest index to the lowest. */
const movingIndices = (reqs: docs_v1.Schema$Request[]) =>
  reqs.flatMap((r) =>
    r.insertText ? [r.insertText.location!.index!] : r.deleteContentRange ? [r.deleteContentRange.range!.startIndex!] : [],
  );

describe("renderItems", () => {
  it("unchanged items → no request, no batchUpdate call", async () => {
    const { result } = await tick(tabText(), desiredFrom);
    expect(result).toBe("ok");
    expect(api.batchUpdate).not.toHaveBeenCalled();
    expect(api.get).toHaveBeenCalledTimes(1); // indices come from readItems' snapshot
  });

  it("changed unlocked item → one replaceNamedRangeContent, guarded by the revision", async () => {
    const { body } = await tick(tabText(), (rs) =>
      desiredFrom(rs).map((d) => (d.id === "n1" ? { ...d, text: "Hackathon 15 feb" } : d)),
    );
    expect(body).toEqual({
      requests: [
        { replaceNamedRangeContent: { namedRangeName: "ss-m1-n1", text: "✓ Hackathon 15 feb", tabsCriteria: { tabIds: [TAB] } } },
      ],
      writeControl: { requiredRevisionId: "rev1" },
    });
  });

  it("a human-edited (locked) item is never rewritten or removed", async () => {
    const edited = tabText({ 5: R("n2", "☐ Simon: boka STOR lokal (fre)") });
    const changed = await tick(edited, (rs) => desiredFrom(rs).map((d) => (d.id === "n2" ? { ...d, text: "ny text" } : d)));
    expect(changed.result).toBe("ok");
    expect(api.batchUpdate).not.toHaveBeenCalled();
    const removed = await tick(edited, (rs) => desiredFrom(rs).filter((d) => d.id !== "n2"));
    expect(removed.result).toBe("ok");
    expect(api.batchUpdate).not.toHaveBeenCalled();
  });

  it("even with stale rows (not yet locked), an item whose paragraph differs is not written", async () => {
    api.get.mockResolvedValueOnce({ data: docJson(tabText({ 3: `OBS ${R("n1", "✓ Hackathon 14 feb")}` })) });
    const { revisionId } = await readItems(auth, "doc1", TAB, rows());
    const result = await renderItems(auth, meeting, rows(), desiredFrom(rows()).map((d) => (d.id === "n1" ? { ...d, text: "x" } : d)), revisionId);
    expect(result.status).toBe("ok");
    expect(api.batchUpdate).not.toHaveBeenCalled();
  });

  it("an edge character deleted and retyped (range one short, paragraph unchanged) → no write", async () => {
    const shrunk = tabText({ 5: "{ss-m1-n2}☐ Simon: boka lokal (fre{/ss-m1-n2})" });
    const same = await tick(shrunk, desiredFrom);
    expect(same.result).toBe("ok");
    expect(api.batchUpdate).not.toHaveBeenCalled();
    const changed = await tick(shrunk, (rs) => desiredFrom(rs).map((d) => (d.id === "n2" ? { ...d, text: "boka sal" } : d)));
    expect(changed.result).toBe("ok");
    expect(api.batchUpdate).not.toHaveBeenCalled();
  });

  it("a new item whose range is already in the Doc (rows not saved after a render) is not inserted again", async () => {
    const text = tabText({ 3: `${R("n1", "✓ Hackathon 14 feb")}\n${R("n5", "✓ X")}` });
    const { result } = await tick(text, (rs) => [...desiredFrom(rs), { id: "n5", section: "decision", text: "X" }]);
    expect(result).toBe("ok");
    expect(api.batchUpdate).not.toHaveBeenCalled();
  });

  it("a deleted item is never re-added", async () => {
    const { result } = await tick(tabText({ 6: "" }), () => desiredFrom(rows()));
    expect(result).toBe("ok");
    expect(api.batchUpdate).not.toHaveBeenCalled();
  });

  it("the 'now' item is rewritten even after a human edit inside its range", async () => {
    const { requests } = await tick(tabText({ 8: R("n4", "Diskussion om något annat") }), desiredFrom);
    expect(requests).toEqual([
      { replaceNamedRangeContent: { namedRangeName: "ss-m1-n4", text: "Diskussion om sponsorer", tabsCriteria: { tabIds: [TAB] } } },
    ]);
  });

  it("the 'now' item is not rewritten when a human pressed Enter inside it and typed a paragraph (B3)", async () => {
    const { requests } = await tick(tabText({ 8: R("n4", "Diskussion om sponsorer\nMin egen anteckning") }), (rs) =>
      desiredFrom(rs).map((d) => (d.id === "n4" ? { ...d, text: "Nytt ämne" } : d)),
    );
    // Replacing the range would erase the human's paragraph.
    expect(requests).toEqual([]);
  });

  it("adds, changes and removes in one batch: descending indices, every request has its tabId", async () => {
    const { requests } = await tick(
      tabText(),
      (rs) => [
        ...desiredFrom(rs)
          .filter((d) => d.id !== "n3")
          .map((d) => (d.id === "n4" ? { ...d, text: "Budget för våren" } : d)),
        { id: "n5", section: "action", text: "maila sponsorer", owner: "Erik" },
        { id: "n6", section: "decision", text: "Ja till 😀-tröjor" },
        { id: "n7", section: "attendees", text: "Simon, Anna" },
      ],
      "LIVE · uppdaterad 10:01",
    );
    for (const r of requests) expect(tabIdsOf(r)).toEqual([TAB]);
    const idx = movingIndices(requests);
    expect(idx).toEqual([...idx].sort((a, b) => b - a));

    const text = docJson(tabText()).tabs![0].documentTab!.body!.content!;
    const paraEnd = (prefix: string) =>
      text.find((c) => c.paragraph?.elements?.[0].textRun?.content?.startsWith(prefix))!.endIndex!;
    const paraStart = (prefix: string) =>
      text.find((c) => c.paragraph?.elements?.[0].textRun?.content?.startsWith(prefix))!.startIndex!;

    // n3 removed: its whole paragraph and its range.
    expect(requests).toContainEqual({ deleteNamedRange: { name: "ss-m1-n3", tabsCriteria: { tabIds: [TAB] } } });
    expect(requests).toContainEqual({
      deleteContentRange: { range: { tabId: TAB, startIndex: paraStart("☐ Anna"), endIndex: paraEnd("☐ Anna") } },
    });
    // n5 after the last surviving action (n2), not after the removed n3.
    const n5At = paraEnd("☐ Simon") - 1;
    expect(requests).toContainEqual({ insertText: { text: "\n☐ Erik: maila sponsorer", location: { tabId: TAB, index: n5At } } });
    expect(requests).toContainEqual({
      createNamedRange: { name: "ss-m1-n5", range: { tabId: TAB, startIndex: n5At + 1, endIndex: n5At + 1 + "☐ Erik: maila sponsorer".length } },
    });
    // n6 after n1; the emoji counts as 2 UTF-16 units, like Docs indices.
    const n6At = paraEnd("✓ Hackathon") - 1;
    expect(requests).toContainEqual({
      createNamedRange: { name: "ss-m1-n6", range: { tabId: TAB, startIndex: n6At + 1, endIndex: n6At + 1 + 19 } },
    });
    // n7: no attendees item yet → after the anchor heading, restyled as normal text.
    const n7At = paraEnd("Närvarande") - 1;
    expect(requests).toContainEqual({ insertText: { text: "\nSimon, Anna", location: { tabId: TAB, index: n7At } } });
    expect(requests).toContainEqual({
      updateParagraphStyle: {
        range: { tabId: TAB, startIndex: n7At + 1, endIndex: n7At + 1 + "Simon, Anna".length },
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        fields: "namedStyleType",
      },
    });
    // n4 replaced; header replaced, last (lowest index).
    expect(requests).toContainEqual({
      replaceNamedRangeContent: { namedRangeName: "ss-m1-n4", text: "Budget för våren", tabsCriteria: { tabIds: [TAB] } },
    });
    expect(requests.at(-1)).toEqual({
      replaceNamedRangeContent: { namedRangeName: "ss-m1-header", text: "LIVE · uppdaterad 10:01", tabsCriteria: { tabIds: [TAB] } },
    });
    // Group order: n4 replace (index of n4) is before the n3 delete, which is before the n5 insert.
    const pos = (pred: (r: docs_v1.Schema$Request) => boolean) => requests.findIndex(pred);
    expect(pos((r) => r.replaceNamedRangeContent?.namedRangeName === "ss-m1-n4")).toBeLessThan(pos((r) => !!r.deleteContentRange));
    expect(pos((r) => !!r.deleteContentRange)).toBeLessThan(pos((r) => r.insertText?.text?.includes("Erik") ?? false));
  });

  it("several new items in one section → one insert, one range each, in order", async () => {
    const { requests } = await tick(tabText(), (rs) => [
      ...desiredFrom(rs),
      { id: "n5", section: "decision", text: "A" },
      { id: "n6", section: "decision", text: "B" },
    ]);
    const at = requests[0].insertText!.location!.index!;
    expect(requests).toEqual([
      { insertText: { text: "\n✓ A\n✓ B", location: { tabId: TAB, index: at } } },
      { createNamedRange: { name: "ss-m1-n5", range: { tabId: TAB, startIndex: at + 1, endIndex: at + 4 } } },
      { createNamedRange: { name: "ss-m1-n6", range: { tabId: TAB, startIndex: at + 5, endIndex: at + 8 } } },
    ]);
  });

  it("removing the tab's last paragraph deletes the newline before it instead of the final one", async () => {
    const { requests } = await tick(tabText(), (rs) => desiredFrom(rs).filter((d) => d.id !== "n4"));
    const content = docJson(tabText()).tabs![0].documentTab!.body!.content!;
    const last = content.at(-1)!;
    expect(requests).toContainEqual({
      deleteContentRange: { range: { tabId: TAB, startIndex: last.startIndex! - 1, endIndex: last.endIndex! - 1 } },
    });
  });

  it("a delete and an insert at the same index: the delete runs first", async () => {
    // Remove n4 (last paragraph → deletes from the newline before it) and add a new 'now' item,
    // which anchors on the "Pågår nu" heading at that same index.
    const { requests } = await tick(tabText(), (rs) => [
      ...desiredFrom(rs).filter((d) => d.id !== "n4"),
      { id: "n8", section: "now", text: "Nästa ämne" },
    ]);
    expect(requests.map((r) => Object.keys(r)[0])).toEqual([
      "deleteNamedRange",
      "deleteContentRange",
      "insertText",
      "createNamedRange",
      "updateParagraphStyle",
    ]);
    expect(requests[1].deleteContentRange!.range!.startIndex).toBe(requests[2].insertText!.location!.index);
  });

  it("header only → a replace of the header range", async () => {
    const { requests } = await tick(tabText(), desiredFrom, "LIVE · uppdaterad 10:05");
    expect(requests).toEqual([
      { replaceNamedRangeContent: { namedRangeName: "ss-m1-header", text: "LIVE · uppdaterad 10:05", tabsCriteria: { tabIds: [TAB] } } },
    ]);
  });

  it("revision mismatch on write → 'conflict'", async () => {
    const { revisionId } = await read(tabText());
    api.batchUpdate.mockRejectedValueOnce(conflict());
    const result = await renderItems(auth, meeting, rows(), [...desiredFrom(rows()), { id: "n5", section: "decision", text: "X" }], revisionId);
    expect(result).toEqual({ status: "conflict" });
  });

  it("other errors are thrown", async () => {
    const { revisionId } = await read(tabText());
    api.batchUpdate.mockRejectedValueOnce(Object.assign(new Error("Invalid requests[0]"), { status: 400 }));
    await expect(
      renderItems(auth, meeting, rows(), [...desiredFrom(rows()), { id: "n5", section: "decision", text: "X" }], revisionId),
    ).rejects.toThrow(/Invalid/);
  });

  it("a revision it has not read: fetches, and on mismatch → 'conflict' without writing", async () => {
    api.get.mockResolvedValueOnce({ data: docJson(tabText(), "rev2") });
    const result = await renderItems(auth, meeting, rows(), [{ id: "n5", section: "decision", text: "X" }], "rev-unknown");
    expect(result).toEqual({ status: "conflict" });
    expect(api.batchUpdate).not.toHaveBeenCalled();
  });
});

describe("renderedRows", () => {
  it("records what was rendered: new items get ranges and positions, removed unlocked rows go, locked stay", () => {
    const rs = rows();
    rs[0] = { ...rs[0], locked: true };
    const next = renderedRows(
      M,
      rs,
      [toNotesItem(rs[1]), { id: "n5", section: "action", text: "maila", owner: "Erik" }, { id: "n4", section: "now", text: "Nytt ämne" }],
      { applied: new Set(["n2", "n5", "n4"]), removed: new Set(["n3"]) },
    );
    expect(next.map((r) => r.id)).toEqual(["n1", "n2", "n4", "n5"]);
    expect(next.find((r) => r.id === "n1")).toEqual(rs[0]);
    expect(next.find((r) => r.id === "n5")).toMatchObject({
      range_name: "ss-m1-n5",
      last_rendered_text: "☐ Erik: maila",
      position: 2,
      locked: false,
    });
    expect(next.find((r) => r.id === "n4")).toMatchObject({ last_rendered_text: "Nytt ämne", range_name: "ss-m1-n4" });
  });

  it("keeps the format fields of a re-rendered row", () => {
    const fmt = {
      kind: "task" as const,
      anchor: "ag-2",
      done: true,
      owner_person_id: "11111111-1111-1111-1111-111111111111",
      carried_from_meeting: "22222222-2222-2222-2222-222222222222",
      carried_from_id: "n7",
      copy_of: "n1",
    };
    const rs = rows();
    rs[1] = { ...rs[1], ...fmt };
    const next = renderedRows(M, rs, [{ ...toNotesItem(rs[1]), text: "ändrad" }], {
      applied: new Set([rs[1].id]),
      removed: new Set(),
    });
    expect(next.find((r) => r.id === rs[1].id)).toMatchObject({ ...fmt, text: "ändrad" });
  });
});

describe("fix round 1", () => {
  const replaceOf = (reqs: docs_v1.Schema$Request[], name: string) =>
    reqs.filter((r) => r.replaceNamedRangeContent?.namedRangeName === name);

  describe("header ownership", () => {
    const HDR = "ss-m1-header";
    it("replaced while it is the single line we last wrote", async () => {
      const { requests, res } = await tick(tabText(), desiredFrom, "LIVE · uppdaterad 10:05");
      expect(replaceOf(requests, HDR)).toHaveLength(1);
      expect(res).toMatchObject({ status: "ok", headerRendered: "LIVE · uppdaterad 10:05" });
    });

    it("a Doc/meeting from before the dot was dropped (old \"● LIVE\" text) is still ours and gets the new line", async () => {
      const old = "● LIVE · uppdaterad 10:00";
      const m = { ...meeting, header_rendered: old };
      const { requests, res } = await tick(tabText({ 0: `{ss-m1-header}${old}{/ss-m1-header}` }), desiredFrom, "LIVE · uppdaterad 10:05", { meeting: m });
      expect(replaceOf(requests, HDR)).toHaveLength(1);
      expect(res).toMatchObject({ status: "ok", headerRendered: "LIVE · uppdaterad 10:05" });
    });

    it("a human typed inside the header range → not replaced", async () => {
      const { requests, res } = await tick(tabText({ 0: "{ss-m1-header}LIVE · uppdaterad 10:00 Simons rad{/ss-m1-header}" }), desiredFrom, "LIVE · uppdaterad 10:05");
      expect(requests).toEqual([]);
      expect(res).toMatchObject({ status: "ok", headerRendered: null });
    });

    it("Enter inside the header range (a second paragraph) → not replaced", async () => {
      const { requests } = await tick(tabText({ 0: "{ss-m1-header}LIVE · uppdaterad\n10:00{/ss-m1-header}" }), desiredFrom, "LIVE · uppdaterad 10:05");
      expect(requests).toEqual([]);
    });

    it("text typed just outside the header range → not replaced", async () => {
      const { requests } = await tick(tabText({ 0: `${H} – Styrelsemöte` }), desiredFrom, "LIVE · uppdaterad 10:05");
      expect(requests).toEqual([]);
    });

    it("no recorded header yet: the coverage check alone decides", async () => {
      const m = { ...meeting, header_rendered: null };
      const ok = await tick(tabText(), desiredFrom, "LIVE · uppdaterad 10:05", { meeting: m });
      expect(replaceOf(ok.requests, HDR)).toHaveLength(1);
      api.batchUpdate.mockReset();
      const edited = await tick(tabText({ 0: `X${H}` }), desiredFrom, "LIVE · uppdaterad 10:05", { meeting: m });
      expect(edited.requests).toEqual([]);
    });
  });

  describe("adjacent removals", () => {
    const withN5 = () => [...rows(), row("n5", "now", "Mer om sponsorer", { position: 1 })];
    const text5 = () => `${tabText()}\n${R("n5", "Mer om sponsorer")}`;
    const deletes = (reqs: docs_v1.Schema$Request[]) => reqs.filter((r) => r.deleteContentRange).map((r) => r.deleteContentRange!.range);
    const paras = (text: string) => docJson(text).tabs![0].documentTab!.body!.content!.filter((c) => c.paragraph);
    const para = (text: string, prefix: string) => paras(text).find((c) => c.paragraph!.elements![0].textRun!.content!.startsWith(prefix))!;

    it("the last two items at the end of the tab → one delete from the newline before them, no overlap", async () => {
      const { requests } = await tick(text5(), (rs) => desiredFrom(rs).filter((d) => d.id !== "n4" && d.id !== "n5"), undefined, { rows: withN5() });
      const lastEnd = paras(text5()).at(-1)!.endIndex!;
      expect(deletes(requests)).toEqual([{ tabId: TAB, startIndex: para(text5(), "Diskussion").startIndex! - 1, endIndex: lastEnd - 1 }]);
      expect(requests.filter((r) => r.deleteNamedRange).map((r) => r.deleteNamedRange!.name).sort()).toEqual(["ss-m1-n4", "ss-m1-n5"]);
    });

    it("two adjacent items in the middle → one delete over both paragraphs", async () => {
      const { requests } = await tick(tabText(), (rs) => desiredFrom(rs).filter((d) => d.id !== "n2" && d.id !== "n3"));
      expect(deletes(requests)).toEqual([
        { tabId: TAB, startIndex: para(tabText(), "☐ Simon").startIndex!, endIndex: para(tabText(), "☐ Anna").endIndex! },
      ]);
    });

    it("all deletes in a batch are disjoint", async () => {
      const { requests } = await tick(text5(), (rs) => desiredFrom(rs).filter((d) => !["n1", "n3", "n4", "n5"].includes(d.id)), undefined, { rows: withN5() });
      const ds = deletes(requests).sort((a, b) => a!.startIndex! - b!.startIndex!);
      for (let i = 1; i < ds.length; i++) expect(ds[i]!.startIndex!).toBeGreaterThanOrEqual(ds[i - 1]!.endIndex!);
      expect(ds).toHaveLength(3);
    });
  });

  describe("rows reflect only what was written", () => {
    it("a skipped removal keeps its row (stale rows, human text in the paragraph)", async () => {
      const { res, requests } = await tick(
        tabText({ 6: `${R("n3", "☐ Anna: budget")} och lite till` }),
        (rs) => desiredFrom(rs).filter((d) => d.id !== "n3"),
        undefined,
        { diff: false },
      );
      expect(requests).toEqual([]);
      expect(res.status === "ok" && res.rows.find((r) => r.id === "n3")).toEqual(rows()[2]);
    });

    it("a skipped change keeps the old last_rendered_text (so the next diff does not lock our own line)", async () => {
      const { res, requests } = await tick(
        tabText({ 3: `OBS ${R("n1", "✓ Hackathon 14 feb")}` }),
        (rs) => desiredFrom(rs).map((d) => (d.id === "n1" ? { ...d, text: "Hackathon 20 feb" } : d)),
        undefined,
        { diff: false },
      );
      expect(requests).toEqual([]);
      expect(res.status === "ok" && res.rows.find((r) => r.id === "n1")).toEqual(rows()[0]);
    });

    it("written changes, inserts and removals are recorded", async () => {
      const { res } = await tick(tabText(), (rs) => [
        ...desiredFrom(rs).filter((d) => d.id !== "n3").map((d) => (d.id === "n1" ? { ...d, text: "Hackathon 20 feb" } : d)),
        { id: "n5", section: "decision", text: "Ny" },
      ]);
      if (res.status !== "ok") throw new Error("expected ok");
      expect(res.rows.map((r) => r.id)).toEqual(["n1", "n2", "n4", "n5"]);
      expect(res.rows.find((r) => r.id === "n1")?.last_rendered_text).toBe("✓ Hackathon 20 feb");
      expect(res.rows.find((r) => r.id === "n5")).toMatchObject({ range_name: "ss-m1-n5", last_rendered_text: "✓ Ny" });
    });
  });

  describe("pending suggestions", () => {
    it("readItems reports them; the diff locks the item", async () => {
      api.get.mockResolvedValueOnce({ data: withSuggestion(docJson(tabText()), "✓ Hackathon", "suggestedDeletionIds") });
      const { current, suggested } = await readItems(auth, "doc1", TAB, rows());
      expect(current.get("n1")).toBe("✓ Hackathon 14 feb"); // a suggested deletion still shows as text
      expect([...suggested]).toEqual(["n1"]);
      expect(diffHumanEdits(rows(), current, suggested).locked.map((l) => l.id)).toEqual(["n1"]);
    });

    it("an item with a suggestion is never replaced or removed, even with stale rows", async () => {
      const doc = () => withSuggestion(docJson(tabText()), "☐ Simon", "suggestedInsertionIds");
      const changed = await tick(doc(), (rs) => desiredFrom(rs).map((d) => (d.id === "n2" ? { ...d, text: "ny" } : d)), undefined, { diff: false });
      expect(changed.requests).toEqual([]);
      const removed = await tick(doc(), (rs) => desiredFrom(rs).filter((d) => d.id !== "n2"), undefined, { diff: false });
      expect(removed.requests).toEqual([]);
    });

    it("the 'now' item is not rewritten while a suggestion is on it", async () => {
      const { requests } = await tick(withSuggestion(docJson(tabText()), "Diskussion", "suggestedInsertionIds"), (rs) =>
        desiredFrom(rs).map((d) => (d.id === "n4" ? { ...d, text: "Nytt ämne" } : d)),
      );
      expect(requests).toEqual([]);
    });

    it("a paragraph-style suggestion counts too", async () => {
      const doc = docJson(tabText());
      const para = doc.tabs![0].documentTab!.body!.content!.find((c) => c.paragraph?.elements?.[0].textRun?.content?.startsWith("☐ Anna"))!;
      para.paragraph!.suggestedParagraphStyleChanges = { "suggest.x": { paragraphStyle: {} } };
      api.get.mockResolvedValueOnce({ data: doc });
      const { suggested } = await readItems(auth, "doc1", TAB, rows());
      expect([...suggested]).toEqual(["n3"]);
    });
  });

  describe("empty items", () => {
    it("a new item with no text is not inserted (no zero-length range) and not recorded", async () => {
      const { requests, res } = await tick(tabText(), (rs) => [...desiredFrom(rs), { id: "n5", section: "now", text: "  \n " }]);
      expect(requests).toEqual([]);
      expect(res.status === "ok" && res.rows.some((r) => r.id === "n5")).toBe(false);
    });

    it("a change to empty text does not empty the range", async () => {
      const { requests, res } = await tick(tabText(), (rs) => desiredFrom(rs).map((d) => (d.id === "n4" ? { ...d, text: "" } : d)));
      expect(requests).toEqual([]);
      expect(res.status === "ok" && res.rows.find((r) => r.id === "n4")).toEqual(rows()[3]);
    });
  });
});

describe("planRender", () => {
  it("is pure over a parsed tab (Task 10 can preview a render)", () => {
    const tab = parseNotesTab(docJson(tabText()), TAB);
    expect(planRender(meeting, tab, rows(), desiredFrom(rows())).requests).toEqual([]);
  });
});
