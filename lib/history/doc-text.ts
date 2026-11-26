import type { docs_v1 } from "@googleapis/docs";

// The plain text of a Google Doc for the protocol import (todo #7): every tab (and child tab) in
// order, paragraphs and table cells (old protocols often keep the date and attendance in a
// table; cells of a row are joined with " | "). Pure. The text only goes to the extraction call;
// it is never stored or logged.

type Content = docs_v1.Schema$StructuralElement[] | undefined;

function contentText(content: Content, out: string[]): void {
  for (const el of content ?? []) {
    if (el.paragraph) {
      const line = (el.paragraph.elements ?? []).map((e) => e.textRun?.content ?? "").join("").replace(/\n$/, "");
      out.push(line);
    } else if (el.table) {
      for (const row of el.table.tableRows ?? []) {
        const cells = (row.tableCells ?? []).map((c) => {
          const inner: string[] = [];
          contentText(c.content, inner);
          return inner.map((l) => l.trim()).filter(Boolean).join(" / ");
        });
        out.push(cells.join(" | "));
      }
    } else if (el.tableOfContents) {
      // A table of contents repeats the headings: skip it.
    }
  }
}

function tabsText(tabs: docs_v1.Schema$Tab[] | undefined, out: string[]): void {
  for (const tab of tabs ?? []) {
    if (tab.documentTab) contentText(tab.documentTab.body?.content, out);
    tabsText(tab.childTabs, out);
  }
}

/** All text of a Doc fetched with includeTabsContent=true (older body-only docs too). */
export function docPlainText(doc: docs_v1.Schema$Document): string {
  const out: string[] = [];
  if (doc.tabs?.length) tabsText(doc.tabs, out);
  else contentText(doc.body?.content, out);
  return out
    .join("\n")
    .replace(/\u000b/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
