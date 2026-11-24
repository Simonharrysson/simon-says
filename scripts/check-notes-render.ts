/**
 * Task 9 early check: notes rendering on a real Google Doc, with a human typing in it.
 *
 *   npm run check-notes-render -- <userId|email> <stage> [args]
 *
 * Stages:
 *   auto              no human needed: own Doc; checks formats read back exactly, an API insert right
 *                     after an item leaves that item's range alone, styles after a heading, what an
 *                     API-deleted paragraph leaves behind, deleting the last paragraph, and that a
 *                     stale revision gives 'conflict'. Prints PASS/FAIL per check.
 *   setup             new Doc for Simon: header, 4 section headings, 5 items rendered. Prints the URL.
 *   inspect           paragraphs, ranges and what the human-edit diff sees now.
 *   tick              one guarded tick like Task 10: read → diff → render (every unlocked item reworded,
 *                     deleted ids offered again, header bumped), up to 4 retries with 150–600 ms backoff.
 *                     Then checks that locked items' paragraphs and deleted items are untouched.
 *   inflight [secs]   read → diff, print "SKRIV NU", wait `secs` (default 8), then write with that
 *                     (now stale) revision: expect 'conflict', then retries until 'ok'.
 *
 * Env as scripts/check-google.ts (never prints secrets). No database writes: the note rows live in
 * .check-notes/state.json (gitignored) together with the Doc id.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OAuth2Client } from "google-auth-library";
import type { MeetingRow, NoteItemRow, NoteSection } from "@/lib/db/types";
import type { NotesItem } from "@/lib/notes/schema";
import { authFor, errInfo, prepareEnv } from "./lib/google-env";

type Notes = typeof import("@/lib/docs/notes");
type G = typeof import("@/lib/google/docs");

const STATE_DIR = join(process.cwd(), ".check-notes");
const stateFile = (name: string) => join(STATE_DIR, `${name}.json`);

interface State {
  url: string;
  meeting: MeetingRow;
  rows: NoteItemRow[];
  ticks: number;
}

const now = () => new Date().toISOString().slice(11, 19);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SECTIONS: { section: NoteSection; title: string }[] = [
  { section: "attendees", title: "Närvarande" },
  { section: "decision", title: "Beslut" },
  { section: "action", title: "Att göra" },
  { section: "now", title: "Pågår nu" },
];
const FIVE: NotesItem[] = [
  { id: "n1", section: "decision", text: "Hackathon 14 februari, budget 8 000 kr" },
  { id: "n2", section: "decision", text: "Nästa möte i Kårallen" },
  { id: "n3", section: "action", text: "boka lokal", owner: "Simon", due: "fre" },
  { id: "n4", section: "action", text: "beställa 😀-tröjor i alla storlekar", owner: "Åsa" },
  { id: "n5", section: "now", text: "Diskussion om sponsorer (Anna, Erik)" },
];

async function main(): Promise<void> {
  const [userArg, stage, ...args] = process.argv.slice(2);
  if (!userArg || !stage) {
    console.error("usage: npm run check-notes-render -- <userId|email> <stage> [args]  (see file header)");
    process.exit(2);
  }
  await prepareEnv();
  const n: Notes = await import("@/lib/docs/notes");
  const g: G = await import("@/lib/google/docs");
  const { userId, auth } = await authFor(userArg);
  console.log(`user ${userId}`);

  switch (stage) {
    case "auto":
      return auto(auth, n, g);
    case "setup": {
      const s = await createDoc(auth, g, `Simon Says renderingstest ${new Date().toISOString().slice(0, 16).replace("T", " ")}`);
      const res = await guardedRender(auth, n, g, s, () => FIVE, `● LIVE · uppdaterad ${now()}`);
      save("state", s);
      console.log(`render of 5 items: ${res}`);
      await inspect(auth, n, g, s);
      console.log(`\nDoc: ${s.url}`);
      return;
    }
    case "inspect":
      return inspect(auth, n, g, load("state"));
    case "tick":
      return tick(auth, n, g, load("state"));
    case "inflight":
      return inflight(auth, n, g, load("state"), Number(args[0] ?? 8));
    default:
      throw new Error(`unknown stage ${stage}`);
  }
}

function save(name: string, s: State) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(stateFile(name), JSON.stringify(s, null, 2));
}
const load = (name: string): State => JSON.parse(readFileSync(stateFile(name), "utf8")) as State;

async function getDoc(auth: OAuth2Client, g: G, docId: string) {
  return (await g.docsApi(auth).documents.get({ documentId: docId, includeTabsContent: true })).data;
}

/** A Doc shaped like Task 6's: header range, then each section heading (HEADING_3) with its anchor range. */
async function createDoc(auth: OAuth2Client, g: G, title: string): Promise<State> {
  const docs = g.docsApi(auth);
  const docId = (await docs.documents.create({ requestBody: { title } })).data.documentId!;
  const tabId = (await getDoc(auth, g, docId)).tabs?.[0]?.tabProperties?.tabId;
  if (!tabId) throw new Error("new doc has no tab");
  const meetingId = randomUUID();
  const header = `ss-${meetingId}-header`;
  const sectionRanges = Object.fromEntries(SECTIONS.map((x) => [x.section, `ss-${meetingId}-sec-${x.section}`]));
  const lines = [{ name: header, text: "● LIVE · uppdaterad –" }, ...SECTIONS.map((x) => ({ name: sectionRanges[x.section], text: x.title }))];
  const requests = [
    { updateDocumentTabProperties: { tabProperties: { tabId, title: "Anteckningar" }, fields: "title" } },
    ...g.paragraphsWithRanges(tabId, 1, lines),
  ];
  let at = 1 + lines[0].text.length + 1;
  for (const x of SECTIONS) {
    requests.push({
      updateParagraphStyle: {
        range: { tabId, startIndex: at, endIndex: at + x.title.length },
        paragraphStyle: { namedStyleType: "HEADING_3" },
        fields: "namedStyleType",
      },
    } as never);
    at += x.title.length + 1;
  }
  await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: requests as never } });
  return {
    url: `https://docs.google.com/document/d/${docId}/edit`,
    ticks: 0,
    rows: [],
    meeting: {
      id: meetingId,
      org_id: "check",
      started_by: null,
      doc_id: docId,
      notes_tab_id: tabId,
      transcript_tab_id: null,
      header_range: header,
      section_ranges: sectionRanges,
      status: "live",
      consent_confirmed_at: null,
      started_at: new Date().toISOString(),
      ended_at: null,
      last_heartbeat_at: null,
      last_tick_at: null,
      last_tick_ok_at: null,
      failed_ticks: 0,
      tick_lease_until: null,
      doc_paused_at: null,
      current_el_session_id: null,
    },
  };
}

/**
 * read → diff → render with that read's revision; on 'conflict' wait 150–600 ms and repeat, max 4
 * retries (the Task 10 loop). `desired` gets the diffed rows. Updates `s.rows` on success.
 */
async function guardedRender(
  auth: OAuth2Client,
  n: Notes,
  g: G,
  s: State,
  desired: (rows: NoteItemRow[]) => NotesItem[],
  headerText?: string,
  opts: { beforeWrite?: () => Promise<void> } = {},
): Promise<string> {
  const m = s.meeting;
  for (let attempt = 0; attempt <= 4; attempt++) {
    if (attempt > 0) await sleep(g.retryDelayMs());
    const { revisionId, current } = await n.readItems(auth, m.doc_id, m.notes_tab_id, s.rows);
    const d = n.diffHumanEdits(s.rows, current);
    const want = desired(d.rows);
    if (attempt === 0 && opts.beforeWrite) await opts.beforeWrite();
    const res = await n.renderItems(auth, m, d.rows, want, revisionId, headerText);
    console.log(`[${now()}] attempt ${attempt + 1}: ${res} (locked ${JSON.stringify(d.locked.map((l) => l.id))}, deleted ${JSON.stringify(d.deletedIds)})`);
    if (res === "ok") {
      s.rows = n.renderedRows(m.id, d.rows, want);
      return attempt === 0 ? "ok" : `ok after ${attempt} conflict(s)`;
    }
  }
  return "FAILED after 4 retries";
}

async function inspect(auth: OAuth2Client, n: Notes, g: G, s: State) {
  const tab = n.parseNotesTab(await getDoc(auth, g, s.meeting.doc_id), s.meeting.notes_tab_id);
  console.log(`\n--- notes tab rev ${tab.revisionId}`);
  for (const p of tab.paragraphs) console.log(`  [${p.start},${p.end}) ${JSON.stringify(p.text)}`);
  for (const [name, entries] of tab.ranges) console.log(`  range ${name.replace(s.meeting.id, "<m>")}: ${JSON.stringify(entries)}`);
  const d = n.diffHumanEdits(s.rows, n.currentItems(tab, s.rows));
  console.log(`diff: locked ${JSON.stringify(d.locked)}; deleted ${JSON.stringify(d.deletedIds)}`);
}

/** Simulated Claude: reword every item it may touch, and offer human-deleted ids again. */
const reworded = (k: number) => (rows: NoteItemRow[]): NotesItem[] =>
  rows.map((r) => ({ ...r, owner: r.owner ?? undefined, due: r.due ?? undefined, text: `${r.text.replace(/ · t\d+$/, "")} · t${k}` }));

async function tick(auth: OAuth2Client, n: Notes, g: G, s: State) {
  s.ticks += 1;
  const before = n.parseNotesTab(await getDoc(auth, g, s.meeting.doc_id), s.meeting.notes_tab_id);
  const d0 = n.diffHumanEdits(s.rows, n.currentItems(before, s.rows));
  const res = await guardedRender(auth, n, g, s, reworded(s.ticks), `● LIVE · uppdaterad ${now()}`);
  console.log(`tick ${s.ticks}: ${res}`);
  save("state", s);
  const after = n.parseNotesTab(await getDoc(auth, g, s.meeting.doc_id), s.meeting.notes_tab_id);
  for (const l of d0.locked) {
    const span = n.itemSpan(after, n.itemRangeName(s.meeting.id, l.id));
    console.log(`${span?.paraText === l.text ? "PASS" : "FAIL"} locked ${l.id} kept verbatim: ${JSON.stringify(span?.paraText)}`);
  }
  for (const id of d0.deletedIds) {
    const back = n.itemSpan(after, n.itemRangeName(s.meeting.id, id));
    console.log(`${back ? "FAIL" : "PASS"} deleted ${id} not re-added`);
  }
  await inspect(auth, n, g, s);
}

async function inflight(auth: OAuth2Client, n: Notes, g: G, s: State, secs: number) {
  s.ticks += 1;
  const res = await guardedRender(auth, n, g, s, reworded(s.ticks), `● LIVE · uppdaterad ${now()}`, {
    beforeWrite: async () => {
      console.log(`\n>>> SKRIV NU i dokumentet (${secs} s) <<<\n`);
      await sleep(secs * 1000);
    },
  });
  console.log(`inflight tick ${s.ticks}: ${res} (expected: first attempt 'conflict', then ok)`);
  save("state", s);
  await inspect(auth, n, g, s);
}

async function auto(auth: OAuth2Client, n: Notes, g: G) {
  const results: string[] = [];
  const check = (ok: boolean, what: string, detail = "") => {
    results.push(`${ok ? "PASS" : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
    console.log(results.at(-1));
  };
  const s = await createDoc(auth, g, `Simon Says renderingstest (automatisk) ${new Date().toISOString().slice(0, 16).replace("T", " ")}`);
  save("auto", s);
  console.log(`Doc: ${s.url}`);
  const m = s.meeting;
  const tab = async () => n.parseNotesTab(await getDoc(auth, g, m.doc_id), m.notes_tab_id);
  const name = (id: string) => n.itemRangeName(m.id, id);

  // 1. Five items: formats read back exactly; no false locks.
  check((await guardedRender(auth, n, g, s, () => FIVE, `● LIVE · uppdaterad ${now()}`)) === "ok", "render 5 items");
  let t = await tab();
  for (const item of FIVE) {
    const span = n.itemSpan(t, name(item.id));
    const want = n.formatItem(item);
    check(span?.paraText === want && span?.rangeText === want, `item ${item.id} reads back exactly`, JSON.stringify(span?.paraText));
  }
  let d = n.diffHumanEdits(s.rows, n.currentItems(t, s.rows));
  check(!d.locked.length && !d.deletedIds.length, "no false locks after render");

  // 2. Styles: items split off a HEADING_3 anchor become NORMAL_TEXT; their text style.
  const raw = await getDoc(auth, g, m.doc_id);
  const content = raw.tabs?.[0]?.documentTab?.body?.content ?? [];
  for (const c of content) {
    if (!c.paragraph) continue;
    const text = (c.paragraph.elements ?? []).map((e) => e.textRun?.content ?? "").join("");
    console.log(`  style ${c.paragraph.paragraphStyle?.namedStyleType} ${JSON.stringify(c.paragraph.elements?.[0]?.textRun?.textStyle)} ${JSON.stringify(text)}`);
  }
  const itemStyles = FIVE.map((i) => {
    const span = n.itemSpan(t, name(i.id))!;
    return content.find((c) => c.startIndex === span.paraStart)?.paragraph?.paragraphStyle?.namedStyleType;
  });
  check(itemStyles.every((x) => x === "NORMAL_TEXT"), "every item paragraph is NORMAL_TEXT", JSON.stringify(itemStyles));

  // 3. Insert right after an item while replacing that item in the same batch: its range must not grow.
  check(
    (await guardedRender(auth, n, g, s, (rows) => [
      ...rows.map((r) => (r.id === "n4" ? { ...n.toNotesItem(r), text: "beställa tröjor (ändrad)" } : n.toNotesItem(r))),
      { id: "n6", section: "action", text: "ny punkt direkt efter n4", owner: "Erik" },
    ])) === "ok",
    "insert n6 after n4 + replace n4 in one batch",
  );
  t = await tab();
  const n4 = n.itemSpan(t, name("n4"));
  const n6 = n.itemSpan(t, name("n6"));
  check(n4?.rangeText === "☐ Åsa: beställa tröjor (ändrad)" && n4?.paraText === n4?.rangeText, "n4 range did not grow", JSON.stringify(n4));
  check(n6?.paraText === "☐ Erik: ny punkt direkt efter n4" && n6?.rangeText === n6?.paraText, "n6 is its own paragraph and range", JSON.stringify(n6));
  d = n.diffHumanEdits(s.rows, n.currentItems(t, s.rows));
  check(!d.locked.length, "no false locks after insert+replace");

  // 4. Remove n6 (a middle paragraph): what is left of its range?
  check((await guardedRender(auth, n, g, s, (rows) => rows.filter((r) => r.id !== "n6").map(n.toNotesItem))) === "ok", "remove n6");
  t = await tab();
  console.log(`  n6 range after API delete: ${JSON.stringify(t.ranges.get(name("n6")) ?? "gone")}`);
  check(!n.itemSpan(t, name("n6")), "n6 range gone or empty");
  check(!t.paragraphs.some((p) => p.text.includes("ny punkt")), "n6 paragraph gone");
  check(n.itemSpan(t, name("n4"))?.paraText === "☐ Åsa: beställa tröjor (ändrad)", "n4 untouched by the removal");

  // 5. Remove the last paragraph (n5, 'now') and add a new 'now' item in the same batch.
  check(
    (await guardedRender(auth, n, g, s, (rows) => [
      ...rows.filter((r) => r.id !== "n5").map(n.toNotesItem),
      { id: "n7", section: "now", text: "Nästa ämne: lokalbokning" },
    ])) === "ok",
    "remove last paragraph + add new 'now' item",
  );
  t = await tab();
  const last = t.paragraphs.at(-1)?.text;
  const beforeLast = t.paragraphs.at(-2)?.text;
  check(last === "Nästa ämne: lokalbokning\n" && beforeLast === "Pågår nu\n", "tab ends with heading + new item", JSON.stringify([beforeLast, last]));
  d = n.diffHumanEdits(s.rows, n.currentItems(t, s.rows));
  check(!d.locked.length && !d.deletedIds.length, "no false locks or deletes after removals");

  // 6. Stale revision → 'conflict', nothing written.
  const { revisionId } = await n.readItems(auth, m.doc_id, m.notes_tab_id, s.rows);
  await g.docsApi(auth).documents.batchUpdate({
    documentId: m.doc_id,
    requestBody: { requests: [g.replaceRange(m.notes_tab_id, m.header_range!, `● LIVE · uppdaterad ${now()} (bump)`)] },
  });
  try {
    const res = await n.renderItems(auth, m, s.rows, [...s.rows.map(n.toNotesItem), { id: "n8", section: "decision", text: "ska inte skrivas" }], revisionId);
    check(res === "conflict", "stale revision → 'conflict'", res);
  } catch (err) {
    check(false, "stale revision → 'conflict'", JSON.stringify(errInfo(err)));
  }
  t = await tab();
  check(!t.paragraphs.some((p) => p.text.includes("ska inte skrivas")), "nothing written on conflict");

  save("auto", s);
  console.log(`\nSUMMARY ${results.filter((r) => r.startsWith("PASS")).length}/${results.length} PASS`);
  for (const r of results.filter((r) => r.startsWith("FAIL"))) console.log(r);
  console.log(`Doc: ${s.url}`);
}

main().catch((err: unknown) => {
  const e = err as Error;
  console.error(`${e.name}: ${e.message}`);
  process.exit(1);
});
