/**
 * Meeting-formats Task A1: measure the Google Docs API on a real, agenda-shaped Doc.
 * A MEASUREMENT script, not a test: PASS/FAIL says whether a measurement ran; the values are the
 * finding (written to docs/learnings.md). Precedent: scripts/check-notes-render.ts.
 *
 *   npm run check-agenda-render -- <userId|email> <stage>
 *
 * Stages:
 *   build     fictional Veckomote agenda Doc (+ a copy whose item 5 is a HEADING_3 "5. Banbokning");
 *             dumps both to fixtures/agenda/*.doc.json (ids scrubbed). State: .check-notes/agenda.json.
 *   auto      M1-M8 (see the brief), each on a fresh Drive copy of the built Doc. Results are printed
 *             and saved to .check-notes/agenda-results.json. Needs `build` first.
 *   human     a fresh copy with three of our bullets under item 4, a named range on the filled
 *             Narvarande cell, then prints the URL and what to type.
 *   inspect   after the human edit: paragraphs, bullets, ranges and itemSpan per range.
 *
 * Env as scripts/check-google.ts (never prints secrets). No database writes. Deletes nothing.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OAuth2Client } from "google-auth-library";
import type { docs_v1 } from "@googleapis/docs";
import { authFor, errInfo, prepareEnv } from "./lib/google-env";

type Doc = docs_v1.Schema$Document;
type Req = docs_v1.Schema$Request;
type G = typeof import("@/lib/google/docs");
type Notes = typeof import("@/lib/docs/notes");

const STATE_DIR = join(process.cwd(), ".check-notes");
const STATE = join(STATE_DIR, "agenda.json");
const RESULTS = join(STATE_DIR, "agenda-results.json");
const FIXTURES = join(process.cwd(), "fixtures", "agenda");

interface State {
  tabId: string;
  baseId: string;
  variantId: string;
  humanId?: string;
}

let auth: OAuth2Client;
let g: G;
let n: Notes;
let tabId = "";

// ---------------------------------------------------------------------------------------------
// Doc helpers

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docsApi = () => g.docsApi(auth);
const urlOf = (id: string) => `https://docs.google.com/document/d/${id}/edit`;

async function get(id: string): Promise<Doc> {
  return (await docsApi().documents.get({ documentId: id, includeTabsContent: true, suggestionsViewMode: "SUGGESTIONS_INLINE" })).data;
}
async function batch(id: string, requests: Req[], revision?: string) {
  return (
    await docsApi().documents.batchUpdate({
      documentId: id,
      requestBody: { requests, ...(revision ? { writeControl: { requiredRevisionId: revision } } : {}) },
    })
  ).data;
}
async function copyDoc(srcId: string, name: string): Promise<string> {
  const res = await g.driveApi(auth).files.copy({ fileId: srcId, requestBody: { name } });
  return res.data.id!;
}
const tabOf = (doc: Doc) => doc.tabs![0].documentTab!;

interface P {
  start: number;
  end: number;
  text: string;
  style: string;
  listId: string | null;
  level: number | null;
  cell: string | null;
  bold: boolean | null;
  fontSize: number | null;
  indentStart: number | null;
  indentFirst: number | null;
}

function paragraphs(doc: Doc): P[] {
  const out: P[] = [];
  const visit = (content: docs_v1.Schema$StructuralElement[] | undefined, cell: string | null) => {
    for (const el of content ?? []) {
      if (el.paragraph) {
        const runs = (el.paragraph.elements ?? []).filter((e) => e.textRun);
        const text = runs.map((e) => e.textRun!.content ?? "").join("");
        const ps = el.paragraph.paragraphStyle;
        out.push({
          start: el.startIndex ?? 0,
          end: el.endIndex ?? 0,
          text: text.replace(/\n$/, ""),
          style: ps?.namedStyleType ?? "?",
          listId: el.paragraph.bullet?.listId ?? null,
          level: el.paragraph.bullet ? (el.paragraph.bullet.nestingLevel ?? 0) : null,
          cell,
          bold: runs[0]?.textRun?.textStyle?.bold ?? null,
          fontSize: runs[0]?.textRun?.textStyle?.fontSize?.magnitude ?? null,
          indentStart: ps?.indentStart?.magnitude ?? null,
          indentFirst: ps?.indentFirstLine?.magnitude ?? null,
        });
      } else if (el.table) {
        el.table.tableRows?.forEach((row, r) => row.tableCells?.forEach((c, ci) => visit(c.content, `r${r}c${ci}`)));
      }
    }
  };
  visit(tabOf(doc).body?.content, null);
  return out;
}

/** Table cells of the first table: paragraph indices of each cell. */
function cells(doc: Doc) {
  const out: { r: number; c: number; start: number; end: number; text: string }[] = [];
  for (const el of tabOf(doc).body?.content ?? []) {
    if (!el.table) continue;
    el.table.tableRows?.forEach((row, r) =>
      row.tableCells?.forEach((cell, c) => {
        const para = cell.content?.[0];
        const text = (para?.paragraph?.elements ?? []).map((e) => e.textRun?.content ?? "").join("");
        out.push({ r, c, start: para?.startIndex ?? 0, end: para?.endIndex ?? 0, text: text.replace(/\n$/, "") });
      }),
    );
    break;
  }
  return out;
}

/** Text at [from,to) over the whole body, table cells included. */
function slice(doc: Doc, from: number, to: number): string {
  const chars = new Map<number, string>();
  const visit = (content: docs_v1.Schema$StructuralElement[] | undefined) => {
    for (const el of content ?? []) {
      for (const pe of el.paragraph?.elements ?? []) {
        const t = pe.textRun?.content;
        if (t == null || pe.startIndex == null) continue;
        for (let i = 0; i < t.length; i++) chars.set(pe.startIndex + i, t[i]);
      }
      el.table?.tableRows?.forEach((row) => row.tableCells?.forEach((c) => visit(c.content)));
    }
  };
  visit(tabOf(doc).body?.content);
  let s = "";
  for (let i = from; i < to; i++) s += chars.get(i) ?? "";
  return s;
}

function namedRanges(doc: Doc) {
  const out: { name: string; parts: { start: number; end: number; text: string }[] }[] = [];
  for (const [name, group] of Object.entries(tabOf(doc).namedRanges ?? {})) {
    for (const nr of group.namedRanges ?? []) {
      out.push({
        name,
        parts: (nr.ranges ?? []).map((r) => ({
          start: r.startIndex ?? 0,
          end: r.endIndex ?? 0,
          text: slice(doc, r.startIndex ?? 0, r.endIndex ?? 0),
        })),
      });
    }
  }
  return out;
}

const ROMAN = ["", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"];
function glyphText(type: string | null | undefined, count: number, symbol?: string | null): string {
  switch (type) {
    case "DECIMAL": return String(count);
    case "ZERO_DECIMAL": return String(count).padStart(2, "0");
    case "ALPHA": return String.fromCharCode(96 + count);
    case "UPPER_ALPHA": return String.fromCharCode(64 + count);
    case "ROMAN": return ROMAN[count] ?? String(count);
    case "UPPER_ROMAN": return (ROMAN[count] ?? String(count)).toUpperCase();
    default: return symbol ?? "•";
  }
}

/** The glyph/number each list paragraph shows, computed from the list's nesting levels (keyed by paragraph start). */
function glyphs(doc: Doc): Map<number, string> {
  const lists = tabOf(doc).lists ?? {};
  const counters = new Map<string, number[]>();
  const out = new Map<number, string>();
  for (const p of paragraphs(doc)) {
    if (!p.listId) continue;
    const c = counters.get(p.listId) ?? [];
    counters.set(p.listId, c);
    const L = p.level ?? 0;
    c[L] = (c[L] ?? 0) + 1;
    c.length = L + 1;
    const levels = lists[p.listId]?.listProperties?.nestingLevels ?? [];
    const fmt = levels[L]?.glyphFormat;
    const t = levels[L]?.glyphType;
    if (!t || t === "GLYPH_TYPE_UNSPECIFIED") {
      out.set(p.start, levels[L]?.glyphSymbol ?? "•");
    } else if (fmt) {
      out.set(p.start, fmt.replace(/%(\d)/g, (_m, i: string) => glyphText(levels[Number(i)]?.glyphType, c[Number(i)] ?? 1)));
    } else out.set(p.start, glyphText(t, c[L]));
  }
  return out;
}

function listLevelInfo(doc: Doc, listId: string) {
  const levels = tabOf(doc).lists?.[listId]?.listProperties?.nestingLevels ?? [];
  return levels.slice(0, 3).map((l, i) => ({
    level: i,
    glyphType: l.glyphType ?? null,
    glyphFormat: l.glyphFormat ?? null,
    glyphSymbol: l.glyphSymbol ?? null,
    indentStart: l.indentStart?.magnitude ?? null,
    indentFirstLine: l.indentFirstLine?.magnitude ?? null,
  }));
}

/** Readable dump; list ids shortened to L1, L2, ... in order of appearance. */
function show(doc: Doc, only?: (p: P) => boolean): string[] {
  const ids = new Map<string, string>();
  const gl = glyphs(doc);
  return paragraphs(doc)
    .filter((p) => !only || only(p))
    .map((p) => {
      let list = "";
      if (p.listId) {
        if (!ids.has(p.listId)) ids.set(p.listId, `list${ids.size + 1}`);
        list = `${ids.get(p.listId)}/lvl${p.level} ${gl.get(p.start)} `;
      }
      const style = p.style === "NORMAL_TEXT" ? "" : `${p.style} `;
      const cell = p.cell ? `{${p.cell}} ` : "";
      return `  [${p.start},${p.end}) ${style}${list}${cell}${JSON.stringify(p.text)}`;
    });
}
const find = (doc: Doc, text: string): P => {
  const p = paragraphs(doc).find((x) => x.text === text);
  if (!p) throw new Error(`no paragraph "${text}"`);
  return p;
};
/** text -> glyph for top-level (level 0) list items. */
function topNumbers(doc: Doc): Record<string, string> {
  const gl = glyphs(doc);
  const out: Record<string, string> = {};
  for (const p of paragraphs(doc)) if (p.listId && p.level === 0) out[p.text] = gl.get(p.start)!;
  return out;
}
const sameNumbering = (before: Record<string, string>, after: Record<string, string>) =>
  Object.keys(before).every((k) => after[k] === before[k]);

// ---------------------------------------------------------------------------------------------
// Reporting

const R: Record<string, unknown> = {};
function rec(key: string, value: unknown) {
  R[key] = value;
  console.log(`  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}
async function measure(name: string, fn: () => Promise<void>) {
  console.log(`\n=== ${name}`);
  try {
    await fn();
    console.log(`PASS ${name} (ran)`);
  } catch (err) {
    console.log(`FAIL ${name}: ${JSON.stringify(errInfo(err))}`);
    R[`${name}.error`] = errInfo(err);
  }
}

// ---------------------------------------------------------------------------------------------
// build

const ITEMS = ["Godkänn dagordning", "Må-runda", "Från förra veckan", "Kommande event", "Ekonomi", "Övrigt"];
const SUBS = ["Sommarfest på Kårallen", "Workshop om sponsring"];
const INFO_LABELS = ["Datum", "Tid", "Närvarande", "Sekreterare"];
const SECRETARY = "Elin Berglund";

async function build(): Promise<State> {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const docId = (await docsApi().documents.create({ requestBody: { title: `Simon Says A1 · Veckomöte (fiktivt) ${stamp}` } })).data.documentId!;
  tabId = tabOf(await get(docId)) && (await get(docId)).tabs![0].tabProperties!.tabId!;
  const loc = (index: number) => ({ index, tabId });

  const lines = [
    "Mötesprotokoll:",
    "", // the table goes here
    "Agenda:",
    ITEMS[0], ITEMS[1], ITEMS[2], ITEMS[3],
    ...SUBS.map((s) => `\t${s}`),
    ITEMS[4], ITEMS[5],
    "Vad ska vi göra till nästa gång?",
    "Ordförande: Boka lokal.",
    "Anteckningar:",
  ];
  await batch(docId, [{ insertText: { text: lines.join("\n"), location: loc(1) } }]);
  let doc = await get(docId);
  const placeholder = paragraphs(doc).find((p) => p.text === "" && p.start > 1);
  if (!placeholder) throw new Error("no placeholder paragraph for the table");
  await batch(docId, [{ insertTable: { rows: 4, columns: 2, location: loc(placeholder.start) } }]);

  doc = await get(docId);
  // insertTable put an empty paragraph before the table (it inserts a newline first); drop it.
  const tableAt = (tabOf(doc).body?.content ?? []).find((e) => e.table)?.startIndex;
  const before = paragraphs(doc).find((p) => p.end === tableAt && p.text === "");
  if (before) {
    try {
      await batch(docId, [{ deleteContentRange: { range: { tabId, startIndex: before.start, endIndex: before.end } } }]);
    } catch (err) {
      console.log(`  (the empty paragraph before the table cannot be deleted: ${errInfo(err).message})`);
    }
  }
  doc = await get(docId);
  const cs = cells(doc);
  // Fill the cells from the last to the first so earlier indices stay valid.
  const fill = new Map<string, string>(INFO_LABELS.map((l, r) => [`${r},0`, l]));
  fill.set(`3,1`, SECRETARY);
  const reqs: Req[] = [...cs]
    .reverse()
    .filter((c) => fill.has(`${c.r},${c.c}`))
    .map((c) => ({ insertText: { text: fill.get(`${c.r},${c.c}`)!, location: loc(c.start) } }));
  await batch(docId, reqs);

  doc = await get(docId);
  const ps = paragraphs(doc);
  const at = (t: string) => ps.find((p) => p.text === t)!;
  const first = at(ITEMS[0]);
  const lastSub = at(`\t${SUBS[1]}`);
  const lastItem = at(ITEMS[5]);
  void lastSub;
  await batch(docId, [
    { updateParagraphStyle: { range: { tabId, startIndex: at("Vad ska vi göra till nästa gång?").start, endIndex: at("Vad ska vi göra till nästa gång?").end }, paragraphStyle: { namedStyleType: "HEADING_2" }, fields: "namedStyleType" } },
    { updateParagraphStyle: { range: { tabId, startIndex: at("Anteckningar:").start, endIndex: at("Anteckningar:").end }, paragraphStyle: { namedStyleType: "HEADING_1" }, fields: "namedStyleType" } },
    // The bullets last: they remove the two tabs, so every index after this range shifts.
    { createParagraphBullets: { range: { tabId, startIndex: first.start, endIndex: lastItem.end - 1 }, bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN" } },
  ]);

  doc = await get(docId);
  console.log("base Doc:");
  console.log(show(doc).join("\n"));
  const listId = find(doc, ITEMS[0]).listId!;
  rec("list.levels", listLevelInfo(doc, listId));

  // Variant: item 5 is a HEADING_3 "5. Banbokning" (not a list item).
  const variantId = await copyDoc(docId, `Simon Says A1 · Veckomöte, rubrik-variant ${stamp}`);
  let vdoc = await get(variantId);
  const eko = find(vdoc, ITEMS[4]);
  await batch(variantId, [
    { deleteParagraphBullets: { range: { tabId, startIndex: eko.start, endIndex: eko.end } } },
    { updateParagraphStyle: { range: { tabId, startIndex: eko.start, endIndex: eko.end }, paragraphStyle: { namedStyleType: "HEADING_3" }, fields: "namedStyleType" } },
  ]);
  vdoc = await get(variantId);
  const e2 = find(vdoc, ITEMS[4]);
  await batch(variantId, [
    { deleteContentRange: { range: { tabId, startIndex: e2.start, endIndex: e2.end - 1 } } },
    { insertText: { text: "5. Banbokning", location: loc(e2.start) } },
  ]);
  vdoc = await get(variantId);
  console.log("variant Doc:");
  console.log(show(vdoc).join("\n"));

  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(join(FIXTURES, "veckomote.doc.json"), JSON.stringify(scrub(await get(docId)), null, 2) + "\n");
  writeFileSync(join(FIXTURES, "veckomote-h3.doc.json"), JSON.stringify(scrub(vdoc), null, 2) + "\n");

  const state: State = { tabId, baseId: docId, variantId };
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log(`\nbase:    ${urlOf(docId)}\nvariant: ${urlOf(variantId)}`);
  return state;
}

/** documentId / revisionId to placeholders, anything email-like to example.com. The repo is public. */
function scrub(doc: Doc): unknown {
  const walk = (v: unknown, key?: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    if (typeof v === "string") {
      if (key === "documentId") return "DOC_ID";
      if (key === "revisionId") return "REV_ID";
      if (/@/.test(v)) return "user@example.com";
    }
    return v;
  };
  const out = walk(doc) as Doc;
  out.title = "Veckomöte (fiktivt)";
  return out;
}

// ---------------------------------------------------------------------------------------------
// auto

const loc = (index: number) => ({ index, tabId });
const rng = (startIndex: number, endIndex: number) => ({ tabId, startIndex, endIndex });
let fresh: (label: string) => Promise<string>;

/** Insert "\n<line>" before item p's newline; return the doc and the new paragraph. */
async function insertAfter(id: string, p: P, line: string, prefix = "") {
  await batch(id, [{ insertText: { text: `\n${prefix}${line}`, location: loc(p.end - 1) } }]);
  const doc = await get(id);
  return { doc, np: paragraphs(doc).find((x) => x.start === p.end)! };
}

async function auto(s: State) {
  tabId = s.tabId;
  const stamp = new Date().toISOString().slice(11, 16);
  fresh = (label) => copyDoc(s.baseId, `Simon Says A1 · ${label} ${stamp}`);
  const urls: Record<string, string> = {};

  await measure("M1 insert after top-level item", async () => {
    const id = await fresh("M1");
    urls.M1 = urlOf(id);
    const before = await get(id);
    const eko = find(before, "Ekonomi");
    const { doc, np } = await insertAfter(id, eko, "M1 ny rad");
    rec("M1.sameListId", np.listId === eko.listId);
    rec("M1.nestingLevel", np.level);
    rec("M1.style", np.style);
    rec("M1.numbersBefore", topNumbers(before));
    rec("M1.numbersAfter", topNumbers(doc));
    rec("M1.itemsAfterRenumbered", topNumbers(doc)["Övrigt"] !== topNumbers(before)["Övrigt"]);
    console.log(show(doc).join("\n"));
  });

  await measure("M2a text '\\n\\t<line>' + createParagraphBullets(preset)", async () => {
    const id = await fresh("M2a");
    urls.M2a = urlOf(id);
    const before = await get(id);
    const eko = find(before, "Ekonomi");
    const { doc: afterInsert, np } = await insertAfter(id, eko, "M2a rad", "\t");
    rec("M2a.afterInsert", { text: np.text, level: np.level, sameListId: np.listId === eko.listId });
    await batch(id, [{ createParagraphBullets: { range: rng(np.start, np.end), bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN" } }]);
    const doc = await get(id);
    const nn = paragraphs(doc).find((x) => x.text.includes("M2a rad"))!;
    rec("M2a.result", { text: nn.text, level: nn.level, sameListId: nn.listId === eko.listId, glyph: glyphs(doc).get(nn.start) });
    rec("M2a.topLevelNumberingUnchanged", sameNumbering(topNumbers(before), topNumbers(doc)));
    rec("M2a.indexShiftFromRemovedTabs", { expectedEnd: np.end, actualEnd: nn.end, shift: np.end - nn.end });
    rec("M2a.docEndBeforeAfter", [afterInsert.tabs![0].documentTab!.body!.content!.at(-1)!.endIndex, doc.tabs![0].documentTab!.body!.content!.at(-1)!.endIndex]);
    console.log(show(doc).join("\n"));
  });

  await measure("M2b insert after the last nested sub-bullet of item 4", async () => {
    const id = await fresh("M2b");
    urls.M2b = urlOf(id);
    const before = await get(id);
    const sub = find(before, SUBS[1]);
    const { doc, np } = await insertAfter(id, sub, "M2b rad");
    rec("M2b.result", { level: np.level, sameListId: np.listId === sub.listId, glyph: glyphs(doc).get(np.start), style: np.style });
    rec("M2b.topLevelNumberingUnchanged", sameNumbering(topNumbers(before), topNumbers(doc)));
    rec("M2b.itemListIdEqualsItem4", np.listId === find(before, "Kommande event").listId);
    console.log(show(doc).join("\n"));
  });

  await measure("M2c deleteParagraphBullets + indent (non-list, '– ' prefix)", async () => {
    const id = await fresh("M2c");
    urls.M2c = urlOf(id);
    const before = await get(id);
    const eko = find(before, "Ekonomi");
    const { np } = await insertAfter(id, eko, "M2c rad");
    await batch(id, [
      { deleteParagraphBullets: { range: rng(np.start, np.end) } },
      { updateParagraphStyle: { range: rng(np.start, np.end), paragraphStyle: { indentStart: { magnitude: 54, unit: "PT" }, indentFirstLine: { magnitude: 36, unit: "PT" } }, fields: "indentStart,indentFirstLine" } },
      { insertText: { text: "– ", location: loc(np.start) } },
    ]);
    const doc = await get(id);
    const nn = paragraphs(doc).find((x) => x.text.includes("M2c rad"))!;
    rec("M2c.result", { text: nn.text, isList: nn.listId != null, indentStart: nn.indentStart, indentFirst: nn.indentFirst });
    rec("M2c.topLevelNumberingUnchanged", sameNumbering(topNumbers(before), topNumbers(doc)));
    rec("M2c.ovrigtListIdUnchanged", find(doc, "Övrigt").listId === find(before, "Övrigt").listId);
    rec("M2c.numbersAfter", topNumbers(doc));
    console.log(show(doc).join("\n"));
  });

  await measure("M3 insert after a HEADING_3 item", async () => {
    const id = await copyDoc(s.variantId, `Simon Says A1 · M3 ${stamp}`);
    urls.M3 = urlOf(id);
    const head = find(await get(id), "5. Banbokning");
    const { np } = await insertAfter(id, head, "M3 rad");
    rec("M3.inherited", { style: np.style, isList: np.listId != null, bold: np.bold, fontSize: np.fontSize });
    await batch(id, [
      { updateParagraphStyle: { range: rng(np.start, np.end), paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } },
      { createParagraphBullets: { range: rng(np.start, np.end), bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } },
    ]);
    const doc = await get(id);
    const nn = paragraphs(doc).find((x) => x.text === "M3 rad")!;
    rec("M3.afterNormalPlusBullets", { style: nn.style, level: nn.level, glyph: glyphs(doc).get(nn.start), bold: nn.bold, fontSize: nn.fontSize, indentStart: nn.indentStart, listIsNew: nn.listId != null && nn.listId !== find(doc, "Godkänn dagordning").listId });
    rec("M3.headingUnchanged", find(doc, "5. Banbokning").style);
    console.log(show(doc).join("\n"));
  });

  await measure("M4 paragraph text of list items excludes glyph/number", async () => {
    const doc = await get(s.baseId);
    const ps = paragraphs(doc).filter((p) => p.listId);
    const expected = [...ITEMS.slice(0, 4), ...SUBS, ...ITEMS.slice(4)];
    const texts = ps.map((p) => p.text);
    const parsed = n.parseNotesTab(doc, tabId).paragraphs.map((p) => p.text.replace(/\n$/, ""));
    rec("M4.listTexts", texts);
    rec("M4.equalToLabels", JSON.stringify(texts) === JSON.stringify(expected));
    rec("M4.parseNotesTabHasSameTexts", ps.every((p) => parsed.includes(p.text)));
    rec("M4.anyLeadingTabOrGlyph", texts.some((t) => /^[\t\d•a-z]\.?\s*\t/.test(t) || t.startsWith("\t")));
  });

  await measure("M5 named range over a list item survives a middle edit; delete incl. newline removes it", async () => {
    const id = await fresh("M5");
    urls.M5 = urlOf(id);
    let doc = await get(id);
    const item = find(doc, "Må-runda");
    const cleared = find(doc, "Från förra veckan");
    await batch(id, [
      { createNamedRange: { name: "ss-a1-m5", range: rng(item.start, item.end - 1) } },
      { createNamedRange: { name: "ss-a1-m5-clear", range: rng(cleared.start, cleared.end - 1) } },
    ]);
    await batch(id, [{ insertText: { text: "XX", location: loc(item.start + 3) } }]);
    doc = await get(id);
    let span = n.itemSpan(n.parseNotesTab(doc, tabId), "ss-a1-m5");
    rec("M5.afterMiddleEdit", { rangeText: span?.rangeText, paraText: span?.paraText });
    // Only the text of "Från förra veckan" deleted, newline kept.
    const c2 = find(doc, "Från förra veckan");
    await batch(id, [{ deleteContentRange: { range: rng(c2.start, c2.end - 1) } }]);
    doc = await get(id);
    const clr = n.itemSpan(n.parseNotesTab(doc, tabId), "ss-a1-m5-clear");
    rec("M5.textDeletedNewlineKept", { itemSpan: clr, rangeEntries: namedRanges(doc).filter((r) => r.name === "ss-a1-m5-clear") });
    // Whole paragraph incl. newline.
    const m = paragraphs(doc).find((p) => p.text === "Må-XXrunda")!;
    const beforeNums = topNumbers(doc);
    await batch(id, [{ deleteContentRange: { range: rng(m.start, m.end) } }]);
    doc = await get(id);
    span = n.itemSpan(n.parseNotesTab(doc, tabId), "ss-a1-m5");
    rec("M5.afterDeleteInclNewline", { itemSpan: span, rangeEntries: namedRanges(doc).filter((r) => r.name === "ss-a1-m5") });
    rec("M5.numbersBeforeAfterDelete", [beforeNums, topNumbers(doc)]);
  });

  await measure("M6 table cells, named range in an empty cell, replaceNamedRangeContent", async () => {
    const id = await fresh("M6");
    urls.M6 = urlOf(id);
    let doc = await get(id);
    const cs = cells(doc);
    rec("M6.cells", cs);
    const target = cs.find((c) => c.r === 2 && c.c === 1)!;
    rec("M6.targetEmpty", { text: target.text, para: [target.start, target.end] });
    const text = "Anna Svensson, Bo Karlsson";
    await batch(id, [
      { insertText: { text, location: loc(target.start) } },
      { createNamedRange: { name: "ss-a1-cell", range: rng(target.start, target.start + text.length) } },
    ]);
    doc = await get(id);
    let nr = namedRanges(doc).find((r) => r.name === "ss-a1-cell");
    rec("M6.rangeAfterCreate", nr?.parts);
    rec("M6.rangeTextEqualsCellText", nr?.parts[0]?.text === cells(doc).find((c) => c.r === 2 && c.c === 1)!.text);
    const sek = cells(doc).find((c) => c.r === 3 && c.c === 1)!;
    rec("M6.secretaryCellIndicesAfterEarlierInsert", { was: cs.find((c) => c.r === 3 && c.c === 1), now: sek });
    await batch(id, [g.replaceRange(tabId, "ss-a1-cell", "Anna, Bo och Cecilia")]);
    doc = await get(id);
    nr = namedRanges(doc).find((r) => r.name === "ss-a1-cell");
    rec("M6.afterReplaceNamedRangeContent", { range: nr?.parts, cellText: cells(doc).find((c) => c.r === 2 && c.c === 1)!.text });
    const tab = n.parseNotesTab(doc, tabId);
    const texts = tab.paragraphs.map((p) => p.text);
    rec("M6.parseNotesTabSkipsTable", !texts.some((t) => t.includes("Sekreterare") || t.includes("Elin") || t.includes("Anna")));
    rec("M6.parseNotesTabRangeInCell", { ranges: [...tab.ranges.keys()], itemSpan: n.itemSpan(tab, "ss-a1-cell") });
    console.log(show(doc, (p) => p.cell != null).join("\n"));
  });

  await measure("M7 one batch: insertText + createParagraphBullets + createNamedRange (+ requiredRevisionId)", async () => {
    const line = "M7 rad";
    // (i) range created AFTER the bullets in the same batch: pre- and post-removal index guesses.
    let id = await fresh("M7a");
    urls.M7a = urlOf(id);
    let doc = await get(id);
    let eko = find(doc, "Ekonomi");
    let ns = eko.end; // the new paragraph's start
    const len = 1 + line.length; // "\t" + line, before the tab is removed
    const res = await batch(id, [
      { insertText: { text: `\n\t${line}`, location: loc(eko.end - 1) } },
      { createParagraphBullets: { range: rng(ns, ns + len + 1), bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN" } },
      { createNamedRange: { name: "ss-a1-m7-pre", range: rng(ns, ns + len) } },
      { createNamedRange: { name: "ss-a1-m7-post", range: rng(ns, ns + len - 1) } },
    ], doc.revisionId!);
    rec("M7a.replies", res.replies?.length);
    doc = await get(id);
    const np = paragraphs(doc).find((p) => p.text.includes(line))!;
    rec("M7a.paragraph", { start: np.start, end: np.end, text: np.text, level: np.level });
    rec("M7a.ranges", namedRanges(doc).filter((r) => r.name.startsWith("ss-a1-m7")));
    // (ii) range created BEFORE the bullets: does it follow the tab removal?
    id = await fresh("M7b");
    urls.M7b = urlOf(id);
    doc = await get(id);
    eko = find(doc, "Ekonomi");
    ns = eko.end;
    await batch(id, [
      { insertText: { text: `\n\t${line}`, location: loc(eko.end - 1) } },
      { createNamedRange: { name: "ss-a1-m7-before", range: rng(ns + 1, ns + 1 + line.length) } }, // label text, tab still there
      { createParagraphBullets: { range: rng(ns, ns + len + 1), bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN" } },
    ], doc.revisionId!);
    doc = await get(id);
    rec("M7b.ranges", namedRanges(doc).filter((r) => r.name === "ss-a1-m7-before"));
    const np2 = paragraphs(doc).find((p) => p.text.includes(line))!;
    rec("M7b.paragraph", { start: np2.start, end: np2.end, text: np2.text, level: np2.level });
  });

  await measure("M7c same batch on a NON-list paragraph (tab removal really happens there)", async () => {
    const line = "M7c rad";
    const len = 1 + line.length;
    let id = await fresh("M7c1");
    urls.M7c1 = urlOf(id);
    let doc = await get(id);
    let ord = find(doc, "Ordförande: Boka lokal.");
    let ns = ord.end;
    await batch(id, [
      { insertText: { text: `\n\t${line}`, location: loc(ord.end - 1) } },
      { createParagraphBullets: { range: rng(ns, ns + len + 1), bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN" } },
      { createNamedRange: { name: "ss-a1-m7c-pre", range: rng(ns, ns + len) } },
      { createNamedRange: { name: "ss-a1-m7c-post", range: rng(ns, ns + len - 1) } },
    ], doc.revisionId!);
    doc = await get(id);
    let np = find(doc, line);
    rec("M7c.afterBullets.paragraph", { start: np.start, end: np.end, text: np.text, level: np.level, newList: np.listId != null && np.listId !== find(doc, "Godkänn dagordning").listId, glyph: glyphs(doc).get(np.start) });
    rec("M7c.ranges(created after bullets)", namedRanges(doc).filter((r) => r.name.startsWith("ss-a1-m7c")));
    id = await fresh("M7c2");
    urls.M7c2 = urlOf(id);
    doc = await get(id);
    ord = find(doc, "Ordförande: Boka lokal.");
    ns = ord.end;
    await batch(id, [
      { insertText: { text: `\n\t${line}`, location: loc(ord.end - 1) } },
      { createNamedRange: { name: "ss-a1-m7c-before", range: rng(ns + 1, ns + 1 + line.length) } }, // label only, tab still there
      { createParagraphBullets: { range: rng(ns, ns + len + 1), bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN" } },
    ], doc.revisionId!);
    doc = await get(id);
    np = find(doc, line);
    rec("M7c.ranges(created before bullets)", namedRanges(doc).filter((r) => r.name === "ss-a1-m7c-before"));
    rec("M7c.paragraph2", { start: np.start, end: np.end, level: np.level });
    // two tabs: nesting level
    id = await fresh("M7c3");
    urls.M7c3 = urlOf(id);
    doc = await get(id);
    ord = find(doc, "Ordförande: Boka lokal.");
    await batch(id, [{ insertText: { text: `\nrot\n\t\tdjup`, location: loc(ord.end - 1) } }]);
    doc = await get(id);
    const rot = find(doc, "rot");
    const djup = find(doc, "\t\tdjup");
    await batch(id, [{ createParagraphBullets: { range: rng(rot.start, djup.end), bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN" } }]);
    doc = await get(id);
    rec("M7c.twoTabs", paragraphs(doc).filter((p) => p.text === "rot" || p.text === "djup").map((p) => ({ text: p.text, level: p.level, sameListAsHuman: p.listId === find(doc, "Godkänn dagordning").listId, start: p.start })));
  });

  await measure("M8 appended headings and the LIVE line after a HEADING_1", async () => {
    // A: "\n<text>" at the end of the HEADING_1 "Anteckningar:" (also the end of the tab).
    let id = await fresh("M8a");
    urls.M8a = urlOf(id);
    let doc = await get(id);
    const h1 = find(doc, "Anteckningar:");
    rec("M8.h1", { style: h1.style, bold: h1.bold, fontSize: h1.fontSize });
    await batch(id, [{ insertText: { text: "\nM8 ny rubrik", location: loc(h1.end - 1) } }]);
    doc = await get(id);
    let np = find(doc, "M8 ny rubrik");
    rec("M8.afterHeading1.inherited", { style: np.style, bold: np.bold, fontSize: np.fontSize });
    await batch(id, [
      { updateParagraphStyle: { range: rng(np.start, np.end), paragraphStyle: { namedStyleType: "HEADING_2" }, fields: "namedStyleType" } },
      { insertText: { text: "\nM8 brödtext", location: loc(np.end - 1) } },
    ]);
    doc = await get(id);
    rec("M8.afterExplicitHeading2", { heading: find(doc, "M8 ny rubrik").style, nextInherits: find(doc, "M8 brödtext").style });
    np = find(doc, "M8 brödtext");
    await batch(id, [{ updateParagraphStyle: { range: rng(np.start, np.end), paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } }]);
    // B: "<text>\n" inserted at the start of the paragraph that follows the HEADING_1 ("directly after").
    id = await fresh("M8b");
    urls.M8b = urlOf(id);
    doc = await get(id);
    const h = find(doc, "Anteckningar:");
    await batch(id, [{ insertText: { text: "\nbrödtext", location: loc(h.end - 1) } }]);
    doc = await get(id);
    const body = find(doc, "brödtext");
    await batch(id, [{ updateParagraphStyle: { range: rng(body.start, body.end), paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } }]);
    doc = await get(id);
    const body2 = find(doc, "brödtext");
    rec("M8.followingParagraphStyle", body2.style);
    await batch(id, [{ insertText: { text: "● LIVE · test\n", location: loc(body2.start) } }]);
    doc = await get(id);
    const live = find(doc, "● LIVE · test");
    rec("M8.liveLineAfterHeading1", { style: live.style, bold: live.bold, fontSize: live.fontSize, heading1Style: find(doc, "Anteckningar:").style, bodyStyle: find(doc, "brödtext").style });
    console.log(show(doc, (p) => p.start >= h.start).join("\n"));
  });

  rec("urls", urls);
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(RESULTS, JSON.stringify(R, null, 2));
  console.log(`\nresults saved to ${RESULTS}`);
}

// ---------------------------------------------------------------------------------------------
// human / inspect

async function human(s: State) {
  tabId = s.tabId;
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const id = await copyDoc(s.baseId, `Simon Says A1 · mänsklig redigering ${stamp}`);
  let doc = await get(id);
  const target = cells(doc).find((c) => c.r === 2 && c.c === 1)!;
  const cellText = "Anna Svensson, Bo Karlsson";
  await batch(id, [
    { insertText: { text: cellText, location: loc(target.start) } },
    { createNamedRange: { name: "ss-a1-cell", range: rng(target.start, target.start + cellText.length) } },
  ]);
  doc = await get(id);
  const sub = find(doc, SUBS[1]);
  const names = ["ss-a1-A", "ss-a1-B", "ss-a1-C"];
  const labels = ["Claude A", "Claude B", "Claude C"];
  let at = sub.end; // start of the first new paragraph
  const reqs: Req[] = [{ insertText: { text: `\n${labels.join("\n")}`, location: loc(sub.end - 1) } }];
  labels.forEach((l, i) => {
    reqs.push({ createNamedRange: { name: names[i], range: rng(at, at + l.length) } });
    at += l.length + 1;
  });
  await batch(id, reqs);
  const hs: State = { ...s, humanId: id };
  writeFileSync(STATE, JSON.stringify(hs, null, 2));
  await inspect(hs);
  console.log(`
Doc: ${urlOf(id)}

Do exactly this in the Docs editor (Chrome), in order, one action at a time:
  1. Click at the very END of the line "Claude A" and press Enter, then type: Manniska 1
  2. Click in the line "Claude B" and press Tab (indent one level), nothing else.
  3. Click at the very END of the line "Claude C" and press Enter, then type: Manniska 2
  4. In the table, click at the very END of the Narvarande cell ("Anna Svensson, Bo Karlsson") and type: , Cecilia
  5. Click at the very START of that same cell, type: X  (so the edit is before our text)
Then run:  npm run check-agenda-render -- <user> inspect`);
}

async function inspect(s: State) {
  if (!s.humanId) throw new Error("no human Doc; run the human stage first");
  tabId = s.tabId;
  const doc = await get(s.humanId);
  console.log(`\n--- ${urlOf(s.humanId)}  rev ${doc.revisionId}`);
  console.log(show(doc, (p) => p.listId != null || p.cell != null || /Claude|Manniska/.test(p.text)).join("\n"));
  const tab = n.parseNotesTab(doc, tabId);
  for (const r of namedRanges(doc)) {
    const span = n.itemSpan(tab, r.name);
    console.log(`  range ${r.name}: ${JSON.stringify(r.parts)}`);
    console.log(`    itemSpan (parseNotesTab; skips tables): ${JSON.stringify(span)}`);
  }
  const lvl = paragraphs(doc).filter((p) => p.listId).map((p) => `${p.level}:${p.text}`);
  console.log(`  levels: ${JSON.stringify(lvl)}`);
  console.log(`  distinct listIds: ${new Set(paragraphs(doc).map((p) => p.listId).filter(Boolean)).size}`);
}

async function main(): Promise<void> {
  const [userArg, stage] = process.argv.slice(2);
  if (!userArg || !stage) {
    console.error("usage: npm run check-agenda-render -- <userId|email> <build|auto|human|inspect>");
    process.exit(2);
  }
  await prepareEnv();
  n = await import("@/lib/docs/notes");
  g = await import("@/lib/google/docs");
  const a = await authFor(userArg);
  auth = a.auth;
  console.log(`user ${a.userId}`);
  const state = (): State => JSON.parse(readFileSync(STATE, "utf8")) as State;
  switch (stage) {
    case "build":
      await build();
      return;
    case "auto":
      return auto(state());
    case "human":
      return human(state());
    case "inspect":
      return inspect(state());
    default:
      throw new Error(`unknown stage ${stage}`);
  }
}

main().catch((err) => {
  console.error(errInfo(err));
  process.exit(1);
});
void sleep;
