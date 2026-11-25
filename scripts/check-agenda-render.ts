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
 *   inspect   after the human edit: paragraphs, bullets, ranges and itemSpan per range
 *             (`inspect a6`: the same for the A6 render Doc).
 *   render    (Task A6) a fresh copy, anchored by hand-made ranges (ss-a6-ag-1..6, sec-tasks, sec-notes,
 *             live) plus a LIVE line, then ONE planFormatRender batch through renderItems: notes under
 *             ag-4 and ag-5, a decision, two Kassör tasks (+ their tasks copies), a note in `notes`,
 *             Närvarande in the empty cell. Checks numbering, ownership, and that a re-render is a no-op.
 *             State: .check-notes/agenda-a6.json. Then prints what the human types.
 *   tick      (Task A6) after the human edits: read + diff (locks), reword every unlocked item, add one
 *             more note under ag-4 and ag-5, render again; checks the human text, the edited copy, the
 *             numbering, the re-indented line's level and lock state.
 *   fallback <veckomote|styrelseprotokoll|bare|testmote>
 *             (Task A7) createFormatDoc (folder "Simon Says – Fiktiv förening A7") then anchorAgenda with
 *             rolesFromSkeleton, prints the Doc and the scan; then ONE renderItems/planFormatRender batch
 *             (notes, a decision, a task + its tasks copy, Närvarande) to see where lines land. `bare` =
 *             the Veckomöte skeleton without tasks/notes headings (the Doc ends in the numbered list),
 *             anchored with VECKOMOTE: the appended headings + LIVE line after a list item. `testmote` = own items
 *             with sub-items, Datum + Sekreterare pre-filled, transcript tab.
 *             State: .check-notes/agenda-a7-<kind>.json.
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
type FR = typeof import("@/lib/docs/format-render");

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
let fr: FR;
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

// ---------------------------------------------------------------------------------------------
// render / tick (Task A6)

const A6_STATE = join(STATE_DIR, "agenda-a6.json");
const A6_LIVE = "Simon Says antecknar live · uppdaterad –";
const A6_PEOPLE: Record<string, string> = { "Anna Berg": "Kassör", "Lisa Holm": "Kassör", "Erik Lund": "Ordförande" };
const a6Label = (owner: string) => A6_PEOPLE[owner] ?? owner;

type MeetingRow = import("@/lib/db/types").MeetingRow;
type NoteItemRow = import("@/lib/db/types").NoteItemRow;
type NotesItem = import("@/lib/notes/schema").NotesItem;
interface A6State {
  docId: string;
  meeting: MeetingRow;
  rows: NoteItemRow[];
  numbering: Record<string, string>;
}

async function a6Render(m: MeetingRow, rows: NoteItemRow[], desired: NotesItem[], headerText: string) {
  const profile = (await import("@/lib/formats/standard")).VECKOMOTE;
  for (let attempt = 0; attempt < 4; attempt++) {
    const tab = await n.readNotesTab(auth, m.doc_id, m.notes_tab_id);
    const res = await n.renderItems(auth, m, rows, desired, tab.revisionId, headerText, { plan: fr.planFormatRender, profile, ownerLabel: a6Label });
    if (res.status === "ok") return res;
    console.log("  revision conflict, retrying");
    await sleep(150 + Math.random() * 450);
  }
  throw new Error("render: 4 conflicts");
}

/** Every rendered row still ours (ownedSpan), and an immediate re-plan writes nothing. */
async function a6Checks(s: A6State, desired: NotesItem[], label: string) {
  const profile = (await import("@/lib/formats/standard")).VECKOMOTE;
  const doc = await get(s.docId);
  const tab = n.parseNotesTab(doc, tabId);
  console.log(show(doc, (p) => p.start > 83).join("\n"));
  const unowned = s.rows.filter((r) => r.range_name && !r.locked && !r.deleted_by_human && !n.ownedSpan(tab, r)).map((r) => r.id);
  rec(`${label}.unownedRows`, unowned);
  const again = fr.planFormatRender(s.meeting, tab, s.rows, desired, { profile, ownerLabel: a6Label });
  rec(`${label}.rerenderRequests`, again.requests.length);
  rec(`${label}.numberingUnchanged`, sameNumbering(s.numbering, topNumbers(doc)));
  rec(`${label}.numbering`, topNumbers(doc));
  rec(`${label}.listIds`, new Set(paragraphs(doc).map((p) => p.listId).filter(Boolean)).size);
  const lines = paragraphs(doc).filter((p) => s.rows.some((r) => r.last_rendered_text === p.text));
  rec(`${label}.ourLines`, lines.map((p) => ({ text: p.text, listId: p.listId ? (p.listId === find(doc, "Ekonomi").listId ? "human" : "other") : null, level: p.level, indent: [p.indentStart, p.indentFirst] })));
  return doc;
}

async function render(s: State) {
  tabId = s.tabId;
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const docId = await copyDoc(s.baseId, `Simon Says A6 · rendering (fiktivt) ${stamp}`);
  let doc = await get(docId);
  const numbering = topNumbers(doc);
  // Hand-made anchors (what A7 will do): item text ranges, both headings, a LIVE line after "Anteckningar:".
  const mid = "a6";
  const notesH = find(doc, "Anteckningar:");
  const reqs: Req[] = [
    { insertText: { text: `\n${A6_LIVE}`, location: loc(notesH.end - 1) } },
    { updateParagraphStyle: { range: rng(notesH.end, notesH.end + A6_LIVE.length), paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } },
    { createNamedRange: { name: `ss-${mid}-live`, range: rng(notesH.end, notesH.end + A6_LIVE.length) } },
    { createNamedRange: { name: `ss-${mid}-sec-notes`, range: rng(notesH.start, notesH.end - 1) } },
  ];
  const tasksH = find(doc, "Vad ska vi göra till nästa gång?");
  reqs.push({ createNamedRange: { name: `ss-${mid}-sec-tasks`, range: rng(tasksH.start, tasksH.end - 1) } });
  ITEMS.forEach((label, i) => {
    const p = find(doc, label);
    reqs.push({ createNamedRange: { name: `ss-${mid}-ag-${i + 1}`, range: rng(p.start, p.end - 1) } });
  });
  await batch(docId, reqs);

  const meeting: MeetingRow = {
    id: mid, org_id: "fiktiv", started_by: null, doc_id: docId, notes_tab_id: tabId, transcript_tab_id: null,
    header_range: `ss-${mid}-live`, header_rendered: A6_LIVE,
    section_ranges: {
      ...Object.fromEntries(ITEMS.map((_, i) => [`ag-${i + 1}`, `ss-${mid}-ag-${i + 1}`])),
      tasks: `ss-${mid}-sec-tasks`, notes: `ss-${mid}-sec-notes`, live: `ss-${mid}-live`,
    },
    status: "live", consent_confirmed_at: null, started_at: new Date().toISOString(), ended_at: null,
    last_heartbeat_at: null, last_tick_at: null, last_tick_ok_at: null, failed_ticks: 0, tick_lease_until: null,
    doc_paused_at: null, current_el_session_id: null, layout: "format", agenda_doc: true,
  };
  const items: NotesItem[] = [
    { id: "n1", section: "note", anchor: "ag-4", text: "Sommarfesten blir lördag 14 juni" },
    { id: "n2", section: "note", anchor: "ag-5", text: "Kassan ser bra ut inför våren" },
    { id: "n3", section: "decision", anchor: "ag-4", text: "Vi köper nya flaggor för 2 000 kr" },
    { id: "n4", section: "action", anchor: "ag-5", text: "Mejla klubben om avgiften.", owner: "Anna Berg", due: "fre" },
    { id: "n5", section: "action", anchor: "ag-4", text: "Betala hyran för lokalen", owner: "Lisa Holm" },
    { id: "n6", section: "note", anchor: "notes", text: "Nästa möte hålls i Kårallen" },
    { id: "info-narvarande", section: "attendees", anchor: "info.narvarande", text: "Anna Berg, Lisa Holm, Erik Lund" },
  ];
  const profile = (await import("@/lib/formats/standard")).VECKOMOTE;
  const desired = fr.expandCopies(items, [], profile);
  const res = await a6Render(meeting, [], desired, "Simon Says antecknar live · uppdaterad 18:10");
  if (res.status !== "ok") throw new Error("render failed");
  const st: A6State = { docId, meeting: { ...meeting, header_rendered: res.headerRendered ?? A6_LIVE }, rows: res.rows, numbering };
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(A6_STATE, JSON.stringify(st, null, 2));
  rec("render.rows", res.rows.map((r) => ({ id: r.id, anchor: r.anchor, last: r.last_rendered_text })));
  rec("render.header", res.headerRendered);
  await a6Checks(st, desired, "render");
  doc = await get(docId);
  rec("render.narvarandeCell", cells(doc).find((c) => c.r === 2 && c.c === 1)?.text);
  writeFileSync(RESULTS.replace(".json", "-a6-render.json"), JSON.stringify(R, null, 2));
  console.log(`
Doc: ${urlOf(docId)}

Do exactly this in the Docs editor (Chrome), in order, one action at a time:
  1. Click at the very END of the agenda line "Ekonomi", press Enter, press Tab, type: Mänsklig underpunkt
  2. In the tasks section, click at the very END of the line "Kassör: Mejla klubben om avgiften (fre)." and type a space, then: Klart!
  3. Click in our line "Sommarfesten blir lördag 14 juni." (under "Kommande event") and press Tab once, nothing else.
Then run:  npm run check-agenda-render -- <user> tick`);
}

async function tick() {
  const st = JSON.parse(readFileSync(A6_STATE, "utf8")) as A6State;
  tabId = st.meeting.notes_tab_id;
  const profile = (await import("@/lib/formats/standard")).VECKOMOTE;
  const before = await get(st.docId);
  const tab = n.parseNotesTab(before, tabId);
  const diff = n.diffHumanEdits(st.rows, n.currentItems(tab, st.rows), n.suggestedItems(tab, st.rows));
  rec("tick.locked", diff.locked.map((i) => ({ id: i.id, text: i.text })));
  rec("tick.deleted", diff.deletedIds);
  const levelOf = (doc: Doc, text: string) => paragraphs(doc).find((p) => p.text === text)?.level ?? null;
  const tabbed = st.rows.find((r) => r.id === "n1")!;
  rec("tick.tabbedBefore", { level: levelOf(before, tabbed.last_rendered_text!), locked: diff.rows.find((r) => r.id === "n1")!.locked });
  // Simulated Claude: reword every unlocked item (primaries; copies follow via expandCopies), add two.
  const off = new Set([...diff.locked.map((i) => i.id), ...diff.deletedIds]);
  const items: NotesItem[] = diff.rows
    .filter((r) => !off.has(r.id) && !r.copy_of)
    .map((r) => ({ ...n.toNotesItem(r), ...(r.anchor?.startsWith("info.") ? {} : { text: `${r.text.replace(/[.]$/, "")} (uppdaterad)` }) }));
  // New lines only on the first tick (a second tick must not offer n7/n8 again as duplicates).
  const extra: NotesItem[] = [
    { id: "n7", section: "note", anchor: "ag-4", text: "Affischer behövs till festen" },
    { id: "n8", section: "note", anchor: "ag-5", text: "Revisorn kommer i mars" },
  ];
  items.push(...extra.filter((e) => !diff.rows.some((r) => r.id === e.id)));
  const desired = fr.expandCopies([...items, ...diff.locked], diff.rows, profile);
  const res = await a6Render(st.meeting, diff.rows, desired, "Simon Says antecknar live · uppdaterad 18:20");
  if (res.status !== "ok") throw new Error("tick render failed");
  const next: A6State = { ...st, meeting: { ...st.meeting, header_rendered: res.headerRendered ?? st.meeting.header_rendered }, rows: res.rows };
  writeFileSync(A6_STATE, JSON.stringify(next, null, 2));
  const doc = await a6Checks(next, desired, "tick");
  const has = (t: string) => paragraphs(doc).some((p) => p.text === t);
  rec("tick.humanSubbulletIntact", has("Mänsklig underpunkt"));
  rec("tick.editedCopyIntact", paragraphs(doc).some((p) => p.text.startsWith("Kassör: Mejla klubben om avgiften (fre).") && p.text.includes("Klart!")));
  const n1 = res.rows.find((r) => r.id === "n1")!;
  rec("tick.tabbedAfter", { text: n1.last_rendered_text, level: levelOf(doc, n1.last_rendered_text!), locked: n1.locked });
  writeFileSync(RESULTS.replace(".json", "-a6-tick.json"), JSON.stringify(R, null, 2));
  console.log(`\nDoc: ${urlOf(st.docId)}`);
}

// ---------------------------------------------------------------------------------------------
// fallback (Task A7)

async function fallback(kind: string) {
  const { VECKOMOTE, STYRELSEPROTOKOLL } = await import("@/lib/formats/standard");
  const { createFormatDoc } = await import("@/lib/docs/create");
  const { skeletonBlocks, rolesFromSkeleton } = await import("@/lib/formats/skeleton");
  const { anchorAgenda, INITIAL_LIVE_LINE } = await import("@/lib/agenda/anchor");
  const { itemAt, scanAgenda } = await import("@/lib/agenda/scan");
  const { liveHeader } = await import("@/lib/meetings/tick");
  type Profile = import("@/lib/formats/schema").FormatProfile;
  const profiles: Record<string, { profile: Profile; skeleton: Profile }> = {
    veckomote: { profile: VECKOMOTE, skeleton: VECKOMOTE },
    styrelseprotokoll: { profile: STYRELSEPROTOKOLL, skeleton: STYRELSEPROTOKOLL },
    bare: { profile: VECKOMOTE, skeleton: { ...VECKOMOTE, tasksSection: null, notesSection: null } },
    testmote: { profile: VECKOMOTE, skeleton: VECKOMOTE },
  };
  // `testmote`: A13's shape (own items with sub-items, pre-filled cells, transcript tab).
  const testmote = kind === "testmote";
  const blocks = testmote
    ? skeletonBlocks(VECKOMOTE, {
        items: [{ label: "Godkänn dagordning" }, { label: "Må-runda" }, { label: "Kommande event", sub: ["Sommarfest på Kårallen", "Workshop om sponsring"] }, { label: "Övrigt" }],
        filled: { Datum: "2026-11-24", Sekreterare: "Elin Berglund" },
      })
    : null;
  const chosen = profiles[kind];
  if (!chosen) throw new Error(`fallback: unknown kind ${kind} (veckomote|styrelseprotokoll|bare|testmote)`);
  const { profile } = chosen;
  const mid = `a7${kind.slice(0, 4)}`;
  const startedAt = new Date();

  const created = await createFormatDoc(auth, {
    meetingId: mid,
    orgName: "Fiktiv förening A7",
    startedAt,
    memberEmails: [],
    shareTranscript: testmote,
    profile: chosen.skeleton,
    blocks: blocks ?? skeletonBlocks(chosen.skeleton),
  });
  rec("fallback.transcriptTabId", created.transcriptTabId);
  tabId = created.tabId;
  const docId = created.docId;
  console.log(`Doc: ${urlOf(docId)}`);
  console.log("--- skeleton\n" + show(await get(docId)).join("\n"));

  const res = await anchorAgenda(auth, {
    meetingId: mid,
    orgId: "fiktiv",
    docId,
    tabId,
    profile,
    startedAt,
    roles: testmote ? { "ag-1": "procedural", "ag-2": "checkin", "ag-3": "topic", "ag-4": "other" } : rolesFromSkeleton(chosen.skeleton),
  });
  let doc = await get(docId);
  console.log("--- anchored\n" + show(doc).join("\n"));
  rec("fallback.revisionMatches", doc.revisionId === res.revisionId);
  rec("fallback.items", res.scan.items.map((i) => ({ key: i.key, label: i.label, kind: i.kind, role: res.agendaRoles[i.key] })));
  rec("fallback.appended", res.appended);
  rec("fallback.sectionRanges", Object.keys(res.sectionRanges));
  const tab = n.parseNotesTab(doc, tabId);
  const scan = scanAgenda(tab, profile);
  rec("fallback.rescanItems", scan.items.length);
  const live = n.itemSpan(tab, res.headerRange);
  const body = paragraphs(doc).filter((p) => !p.cell);
  const liveIdx = body.findIndex((p) => p.start === live?.paraStart);
  rec("fallback.live", live ? { text: live.paraText, style: body[liveIdx]?.style, listId: body[liveIdx]?.listId, after: body[liveIdx - 1]?.text, inItem: itemAt(scan, live.paraStart)?.key ?? null } : null);
  rec("fallback.ranges", Object.fromEntries(Object.entries(res.sectionRanges).map(([k, name]) => [k, n.itemSpan(tab, name)?.rangeText ?? null])));
  rec("fallback.info", scan.info.map((c) => [c.field, c.valueCell.text]));
  rec("fallback.infoTid", res.rows.map((r) => [r.id, r.last_rendered_text, n.itemSpan(tab, r.range_name!)?.rangeText]));
  if (testmote) {
    rec("fallback.subItems", body.filter((p) => p.text.startsWith("Sommarfest") || p.text.startsWith("Workshop")).map((p) => ({ text: p.text, level: p.level, sameList: p.listId === body.find((x) => x.text === "Kommande event")?.listId })));
    rec("fallback.tabsLeft", paragraphs(doc).some((p) => p.text.includes("\t")));
    rec("fallback.humanText", scan.items.map((i) => [i.label, i.humanText]));
  }
  rec("fallback.appendedStyles", res.appended.map((label) => { const p = body.find((x) => x.text === label); return p ? { label, style: p.style, listId: p.listId, indent: [p.indentStart, p.indentFirst] } : { label, missing: true }; }));

  // One render on the anchored Doc: where do our lines land?
  const meeting: MeetingRow = {
    id: mid, org_id: "fiktiv", started_by: null, doc_id: docId, notes_tab_id: tabId, transcript_tab_id: null,
    header_range: res.headerRange, header_rendered: INITIAL_LIVE_LINE, section_ranges: res.sectionRanges,
    status: "live", consent_confirmed_at: null, started_at: startedAt.toISOString(), ended_at: null,
    last_heartbeat_at: null, last_tick_at: null, last_tick_ok_at: null, failed_ticks: 0, tick_lease_until: null,
    doc_paused_at: null, current_el_session_id: null, layout: "format", agenda_doc: false, agenda_roles: res.agendaRoles,
  };
  const topic = Object.entries(res.agendaRoles).find(([, r]) => r === "topic")?.[0] ?? "ag-1";
  const items: NotesItem[] = [
    { id: "n1", section: "note", anchor: topic, text: "Sommarfesten blir lördag 14 juni" },
    { id: "n2", section: "decision", anchor: topic, text: "Vi köper nya flaggor för 2 000 kr" },
    { id: "n3", section: "action", anchor: topic, text: "Skicka protokollet till alla", owner: "Justerare", due: "fre" },
    { id: "n4", section: "action", anchor: topic, text: "Betala hyran för lokalen", owner: "Anna Berg" },
    ...(profile.notesSection ? [{ id: "n5", section: "note" as const, anchor: "notes", text: "Nästa möte hålls i Kårallen" }] : []),
    { id: "info-narvarande", section: "attendees", anchor: "info.narvarande", text: "Anna Berg, Lisa Holm, Erik Lund" },
  ];
  const ownerLabel = (o: string) => ({ "Anna Berg": "Kassör" } as Record<string, string>)[o] ?? o;
  const desired = fr.expandCopies(items, res.rows, profile);
  let rendered: Awaited<ReturnType<typeof n.renderItems>> | null = null;
  for (let attempt = 0; attempt < 4 && rendered?.status !== "ok"; attempt++) {
    const t = await n.readNotesTab(auth, docId, tabId);
    rendered = await n.renderItems(auth, meeting, res.rows, desired, t.revisionId, liveHeader(new Date(), "format"), { plan: fr.planFormatRender, profile, ownerLabel });
  }
  if (rendered?.status !== "ok") throw new Error("fallback render failed");
  doc = await get(docId);
  console.log("--- rendered\n" + show(doc).join("\n"));
  const t2 = n.parseNotesTab(doc, tabId);
  rec("render.unownedRows", rendered.rows.filter((r) => r.range_name && !r.locked && !n.ownedSpan(t2, r)).map((r) => r.id));
  const again = fr.planFormatRender({ ...meeting, header_rendered: rendered.headerRendered ?? meeting.header_rendered }, t2, rendered.rows, desired, { profile, ownerLabel });
  rec("render.rerenderRequests", again.requests.length);
  rec("render.listIds", new Set(paragraphs(doc).map((p) => p.listId).filter(Boolean)).size);
  const lines = paragraphs(doc).filter((p) => !p.cell).map((p) => p.text);
  const sig = lines.findIndex((x) => /^Mötesordförande:/.test(x));
  rec("render.copiesAboveSignatures", sig < 0 ? "no signatures" : lines.slice(sig).every((x) => !x.startsWith("Justerare: Skicka") && !x.startsWith("Kassör:")));
  rec("render.lines", rendered.rows.map((r) => [r.id, r.anchor, r.last_rendered_text]));
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(STATE_DIR, `agenda-a7-${kind}.json`), JSON.stringify({ docId, meeting, rows: rendered.rows, results: R }, null, 2));
  console.log(`\nDoc: ${urlOf(docId)}`);
}

async function main(): Promise<void> {
  const [userArg, stage] = process.argv.slice(2);
  if (!userArg || !stage) {
    console.error("usage: npm run check-agenda-render -- <userId|email> <build|auto|human|inspect [a6]|render|tick|fallback <kind>>");
    process.exit(2);
  }
  await prepareEnv();
  n = await import("@/lib/docs/notes");
  g = await import("@/lib/google/docs");
  fr = await import("@/lib/docs/format-render");
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
    case "inspect": {
      // `inspect a6`: the A6 render Doc (from .check-notes/agenda-a6.json) instead of the A1 human Doc.
      if (process.argv[4] === "a6") {
        const a6 = JSON.parse(readFileSync(A6_STATE, "utf8")) as A6State;
        return inspect({ ...state(), tabId: a6.meeting.notes_tab_id, humanId: a6.docId });
      }
      return inspect(state());
    }
    case "render":
      return render(state());
    case "tick":
      return tick();
    case "fallback":
      return fallback(process.argv[4] ?? "");
    default:
      throw new Error(`unknown stage ${stage}`);
  }
}

main().catch((err) => {
  console.error(errInfo(err));
  process.exit(1);
});
void sleep;
