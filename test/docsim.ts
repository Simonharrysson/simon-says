import type { docs_v1 } from "@googleapis/docs";

// A small, test-only model of the Docs batchUpdate requests the agenda code sends, applied to a
// `documents.get` JSON. It follows the Task A1 measurements: an inserted "\n" splits a paragraph
// and both halves keep its paragraph style and bullet (M1, M3, M8); a named range grows only when
// text is inserted strictly inside it (typing at an edge lands outside, A1 human stage);
// createParagraphBullets on non-list paragraphs strips leading tabs (N tabs = level N) and makes
// one new list (M7c); insertTable at an empty paragraph leaves an empty paragraph before the
// table and one after it (M6). Anything else throws, so a test never passes on an unmodelled request.

type Doc = docs_v1.Schema$Document;
type El = docs_v1.Schema$StructuralElement;
type Req = docs_v1.Schema$Request;

export const TAB = "t.0";

const tabOf = (doc: Doc) => doc.tabs![0].documentTab!;
const textOf = (el: El) => (el.paragraph?.elements ?? []).map((e) => e.textRun?.content ?? "").join("");

export function paraEl(
  text: string,
  opts: { style?: string; level?: number; listId?: string; bold?: boolean } = {},
): El {
  return {
    paragraph: {
      elements: [{ textRun: { content: `${text}\n`, textStyle: opts.bold ? { bold: true } : {} } }],
      paragraphStyle: { namedStyleType: opts.style ?? "NORMAL_TEXT" },
      ...(opts.level !== undefined ? { bullet: { listId: opts.listId ?? "list-h", nestingLevel: opts.level } } : {}),
    },
  };
}

/** A Doc from body elements (paragraphs, tables); list "list-h" is a numbered human list. */
export function docOf(content: El[]): Doc {
  const doc: Doc = {
    revisionId: "REV_1",
    tabs: [
      {
        tabProperties: { tabId: TAB },
        documentTab: {
          body: { content: [{ sectionBreak: {}, startIndex: 0, endIndex: 1 }, ...content] },
          namedRanges: {},
          lists: { "list-h": { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }, { glyphType: "ALPHA" }, { glyphType: "ROMAN" }] } } },
        },
      },
    ],
  };
  reindex(doc);
  return doc;
}

/** Recompute every index from the content (paragraph = its text; table +1, row +1, cell +1, end +1). */
export function reindex(doc: Doc) {
  let at = 1;
  const visit = (content: El[]) => {
    for (const el of content) {
      if (el.sectionBreak) continue;
      el.startIndex = at;
      if (el.paragraph) {
        for (const pe of el.paragraph.elements ?? []) {
          pe.startIndex = at;
          at += pe.textRun?.content?.length ?? 1;
          pe.endIndex = at;
        }
      } else if (el.table) {
        at += 1;
        for (const row of el.table.tableRows ?? []) {
          row.startIndex = at;
          at += 1;
          for (const cell of row.tableCells ?? []) {
            cell.startIndex = at;
            at += 1;
            visit(cell.content ?? []);
            cell.endIndex = at;
          }
          row.endIndex = at;
        }
        at += 1;
      }
      el.endIndex = at;
    }
  };
  visit(tabOf(doc).body!.content!);
}

/** Every paragraph element with the array holding it (body and table cells), in Doc order. */
function allParas(doc: Doc): { el: El; container: El[] }[] {
  const out: { el: El; container: El[] }[] = [];
  const visit = (content: El[]) => {
    for (const el of content) {
      if (el.paragraph) out.push({ el, container: content });
      for (const row of el.table?.tableRows ?? []) for (const cell of row.tableCells ?? []) visit(cell.content ?? []);
    }
  };
  visit(tabOf(doc).body!.content!);
  return out;
}

const overlapping = (doc: Doc, s: number, e: number) =>
  allParas(doc).filter(({ el }) => el.startIndex! < Math.max(e, s + 1) && el.endIndex! > s);

function setText(el: El, text: string) {
  const bold = el.paragraph!.elements?.[0]?.textRun?.textStyle?.bold;
  el.paragraph!.elements = [{ textRun: { content: text, textStyle: bold ? { bold: true } : {} } }];
}

function shiftRanges(doc: Doc, index: number, delta: number) {
  for (const group of Object.values(tabOf(doc).namedRanges ?? {})) {
    for (const nr of group.namedRanges ?? []) {
      for (const r of nr.ranges ?? []) {
        if (r.startIndex! >= index) {
          r.startIndex! += delta;
          r.endIndex! += delta;
        } else if (r.endIndex! > index) r.endIndex! += delta;
      }
    }
  }
}

function insertText(doc: Doc, text: string, index: number) {
  const hit = allParas(doc).find(({ el }) => index >= el.startIndex! && index < el.endIndex!);
  if (!hit) throw new Error(`docsim: no paragraph at ${index}`);
  const { el, container } = hit;
  const old = textOf(el);
  const off = index - el.startIndex!;
  const joined = old.slice(0, off) + text + old.slice(off);
  const parts = joined.match(/[^\n]*\n/g)!;
  const els = parts.map((part) => {
    const copy = JSON.parse(JSON.stringify(el)) as El;
    setText(copy, part);
    return copy;
  });
  container.splice(container.indexOf(el), 1, ...els);
  shiftRanges(doc, index, text.length);
  reindex(doc);
}

/**
 * deleteContentRange as measured (A1, final review R1-I2 `tablenl`): the range may cross
 * paragraphs of one container (the merged paragraph keeps the FIRST paragraph's style and bullet);
 * the API refuses (400 "Invalid deletion range") a range that touches a table, takes the newline
 * directly before a table, or takes the body's final newline; an empty range is refused too.
 */
function deleteRange(doc: Doc, s: number, e: number) {
  if (e <= s) throw new Error("docsim: The range should not be empty.");
  const hits = allParas(doc).filter(({ el }) => el.startIndex! < e && el.endIndex! > s);
  if (!hits.length || hits.some((h) => h.container !== hits[0].container)) throw new Error("docsim: Invalid deletion range (crosses a table cell)");
  const container = hits[0].container;
  const first = hits[0].el;
  const last = hits[hits.length - 1].el;
  if (s < first.startIndex! || e > last.endIndex!) throw new Error("docsim: Invalid deletion range (touches a table)");
  const i0 = container.indexOf(first);
  const i1 = container.indexOf(last);
  if (container.slice(i0, i1 + 1).some((el) => !el.paragraph)) throw new Error("docsim: Invalid deletion range (touches a table)");
  const next = container[i1 + 1];
  if (e === last.endIndex) {
    if (next?.table) throw new Error("docsim: Invalid deletion range (the newline before a table)");
    if (!next) throw new Error("docsim: Invalid deletion range (the final newline)");
  }
  let text = textOf(first).slice(0, s - first.startIndex!) + textOf(last).slice(e - last.startIndex!);
  const removed = container.slice(i0 + 1, i1 + 1);
  if (text !== "" && !text.endsWith("\n")) {
    // The last newline went: the rest joins the next paragraph (first paragraph's style kept).
    text += textOf(next);
    removed.push(next);
  }
  for (const el of removed) container.splice(container.indexOf(el), 1);
  if (text === "") container.splice(container.indexOf(first), 1);
  else setText(first, text);
  for (const group of Object.values(tabOf(doc).namedRanges ?? {})) {
    for (const nr of group.namedRanges ?? []) {
      for (const r2 of nr.ranges ?? []) {
        const map = (i: number) => (i <= s ? i : i >= e ? i - (e - s) : s);
        r2.startIndex = map(r2.startIndex!);
        r2.endIndex = map(r2.endIndex!);
      }
    }
  }
  reindex(doc);
}

let listCounter = 0;

function insertTable(doc: Doc, rows: number, columns: number, index: number) {
  const hit = allParas(doc).find(({ el }) => el.startIndex === index);
  if (!hit || textOf(hit.el) !== "\n") throw new Error("docsim: insertTable only at an empty paragraph's start");
  const emptyCell = (): docs_v1.Schema$TableCell => ({ content: [paraEl("")] });
  const table: El = {
    table: { rows, columns, tableRows: Array.from({ length: rows }, () => ({ tableCells: Array.from({ length: columns }, emptyCell) })) },
  };
  // A1 M6: an empty paragraph before the table, and the placeholder stays after it.
  hit.container.splice(hit.container.indexOf(hit.el), 0, paraEl(""), table);
  // Every index from `index` on moves by the new paragraph + the table.
  reindex(doc);
  shiftRanges(doc, index, (table.endIndex ?? 0) - index);
}

/** Apply requests in order, as one batchUpdate would. */
export function apply(doc: Doc, requests: Req[]): Doc {
  for (const r of requests) {
    if (r.insertText) {
      if (r.insertText.location?.tabId !== TAB) throw new Error("docsim: insertText without tabId");
      insertText(doc, r.insertText.text!, r.insertText.location.index!);
    } else if (r.createNamedRange) {
      const { name, range } = r.createNamedRange;
      if (range?.tabId !== TAB) throw new Error("docsim: createNamedRange without tabId");
      const named = (tabOf(doc).namedRanges ??= {});
      const group = (named[name!] ??= { name, namedRanges: [] });
      group.namedRanges!.push({ name, namedRangeId: `id-${name}-${group.namedRanges!.length}`, ranges: [{ startIndex: range.startIndex, endIndex: range.endIndex }] });
    } else if (r.deleteNamedRange) {
      const named = tabOf(doc).namedRanges ?? {};
      if (!r.deleteNamedRange.tabsCriteria?.tabIds?.includes(TAB)) throw new Error("docsim: deleteNamedRange without tab");
      delete named[r.deleteNamedRange.name!];
    } else if (r.deleteContentRange) {
      const { startIndex: s, endIndex: e, tabId } = r.deleteContentRange.range!;
      if (tabId !== TAB) throw new Error("docsim: deleteContentRange without tabId");
      deleteRange(doc, s!, e!);
    } else if (r.updateParagraphStyle) {
      const { range, paragraphStyle, fields } = r.updateParagraphStyle;
      if (range?.tabId !== TAB) throw new Error("docsim: updateParagraphStyle without tabId");
      for (const { el } of overlapping(doc, range.startIndex!, range.endIndex!)) {
        const ps = (el.paragraph!.paragraphStyle ??= {});
        for (const f of fields!.split(",")) (ps as Record<string, unknown>)[f] = (paragraphStyle as Record<string, unknown>)[f];
      }
    } else if (r.deleteParagraphBullets) {
      const range = r.deleteParagraphBullets.range!;
      for (const { el } of overlapping(doc, range.startIndex!, range.endIndex!)) delete el.paragraph!.bullet;
    } else if (r.updateTextStyle) {
      if (r.updateTextStyle.range?.tabId !== TAB) throw new Error("docsim: updateTextStyle without tabId");
      // Character styles are not modelled.
    } else if (r.createParagraphBullets) {
      const range = r.createParagraphBullets.range!;
      const listId = `list-${++listCounter}`;
      const preset = r.createParagraphBullets.bulletPreset!;
      tabOf(doc).lists![listId] = {
        listProperties: {
          nestingLevels: preset.startsWith("NUMBERED")
            ? [{ glyphType: "DECIMAL" }, { glyphType: "ALPHA" }, { glyphType: "ROMAN" }]
            : [{ glyphSymbol: "●" }, { glyphSymbol: "○" }, { glyphSymbol: "■" }],
        },
      };
      // Bottom-up so the tab removal does not move the paragraphs still to do.
      const hits = overlapping(doc, range.startIndex!, range.endIndex!).reverse();
      for (const { el } of hits) {
        if (el.paragraph!.bullet) continue; // M7a: an existing list paragraph keeps its tabs
        const text = textOf(el);
        const tabs = /^\t*/.exec(text)![0].length;
        el.paragraph!.bullet = { listId, nestingLevel: tabs };
        if (tabs) {
          setText(el, text.slice(tabs));
          shiftRanges(doc, el.startIndex!, -tabs);
          reindex(doc);
        }
      }
    } else if (r.insertTable) {
      insertTable(doc, r.insertTable.rows!, r.insertTable.columns!, r.insertTable.location!.index!);
    } else if (r.updateDocumentTabProperties || r.addDocumentTab) {
      // no body change
    } else {
      throw new Error(`docsim: unmodelled request ${Object.keys(r)[0]}`);
    }
  }
  doc.revisionId = `${doc.revisionId}+`;
  return doc;
}
