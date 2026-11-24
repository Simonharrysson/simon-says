/**
 * Demo: a recorded meeting played into a real Google Doc, as the live service will do it, minus the
 * microphone. Transcript lines stand in for ElevenLabs; everything after that is the real code path:
 * transcript tab append → read Doc → human-edit diff → Claude (notes engine) → guarded render.
 *
 *   npm run demo-live -- <userId|email> [transcript.jsonl] [--speed 3] [--tick-sec 45]
 *
 * Defaults to fixtures/notes/synthetic.jsonl (a fictional board meeting). The Doc is created in the
 * user's Drive; the URL is printed first so you can open it and watch (and type in it: your edits
 * are kept, as in the real service). Uses ANTHROPIC_API_KEY from ~/simon-says-private/.env.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { OAuth2Client } from "google-auth-library";
import type { MeetingRow, NoteItemRow, NoteSection } from "@/lib/db/types";
import type { NotesClient } from "@/lib/notes/engine";
import type { NotesItem } from "@/lib/notes/schema";
import { authFor, prepareEnv } from "./lib/google-env";

interface Line {
  speaker: string;
  startMs: number;
  text: string;
}

const SECTIONS: { section: NoteSection; title: string }[] = [
  { section: "attendees", title: "Närvarande" },
  { section: "decision", title: "Beslut" },
  { section: "action", title: "Att göra" },
  { section: "now", title: "Pågår nu" },
];
const clock = () => new Date().toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const mmss = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

async function main() {
  const [userArg, maybeFile] = process.argv.slice(2);
  if (!userArg) throw new Error("usage: npm run demo-live -- <userId|email> [transcript.jsonl] [--speed 3]");
  const file = maybeFile && !maybeFile.startsWith("--") ? maybeFile : "fixtures/notes/synthetic.jsonl";
  const speed = Number(arg("speed") ?? 3);
  const tickMs = Number(arg("tick-sec") ?? 45) * 1000;
  const expPath = file.replace(/\.jsonl$/, ".expected.json");
  const expected = existsSync(expPath)
    ? (JSON.parse(readFileSync(expPath, "utf8")) as { orgName?: string; speakerNames?: Record<string, string> })
    : {};
  const orgName = expected.orgName ?? "Föreningen";
  const names = expected.speakerNames ?? {};

  await prepareEnv();
  const apiKey = readFileSync(process.env.SIMON_SAYS_ENV ?? `${process.env.HOME}/simon-says-private/.env`, "utf8")
    .split("\n")
    .map((l) => l.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.*?)\s*$/)?.[1])
    .find(Boolean)
    ?.replace(/^(['"])(.*)\1$/, "$2");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing in the private .env");
  const n = await import("@/lib/docs/notes");
  const g = await import("@/lib/google/docs");
  const { updateNotes } = await import("@/lib/notes/engine");
  const { auth } = await authFor(userArg);

  const lines: Line[] = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Line)
    .sort((a, b) => a.startMs - b.startMs);
  const tickCount = Math.ceil((lines.at(-1)!.startMs + 5000) / tickMs);

  const meeting = await createDoc(auth, g, `${orgName} · demo ${new Date().toLocaleDateString("sv-SE")} ${clock().slice(0, 5)}`);
  console.log(`\nÖppna Doc:en nu:\n  https://docs.google.com/document/d/${meeting.doc_id}/edit\n`);
  console.log(`${lines.length} repliker, ${tickCount} uppdateringar + slutpass, var ${tickMs / 1000 / speed} s (×${speed}). Startar om 10 s…`);
  await sleep(10_000);

  const sdk = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 2 });
  const client: NotesClient = { beta: { messages: { stream: (body) => sdk.beta.messages.stream(body) } } } as NotesClient;

  let rows: NoteItemRow[] = [];
  let nextId: string | undefined;
  let usd = 0;
  const blocks: string[] = [];

  for (let t = 0; t <= tickCount; t++) {
    const final = t === tickCount;
    const t0 = Date.now();
    if (!final) {
      const chunk = lines.filter((l) => l.startMs >= t * tickMs && l.startMs < (t + 1) * tickMs);
      blocks.push(chunk.map((l) => `[${mmss(l.startMs)}] ${l.speaker}: ${l.text}`).join("\n"));
      if (chunk.length && meeting.transcript_tab_id) {
        const text = chunk.map((l) => `[${mmss(l.startMs)}] ${names[l.speaker] ?? l.speaker}: ${l.text}`).join("\n") + "\n";
        await g.docsApi(auth).documents.batchUpdate({
          documentId: meeting.doc_id,
          requestBody: { requests: [g.appendToTab(meeting.transcript_tab_id, text)] },
        });
      }
    }

    // read → diff → Claude → guarded render (retries re-read and re-diff; Claude is asked once per tick)
    let read = await n.readItems(auth, meeting.doc_id, meeting.notes_tab_id, rows);
    let d = n.diffHumanEdits(rows, read.current, read.suggested);
    const tab = n.parseNotesTab(
      (await g.docsApi(auth).documents.get({ documentId: meeting.doc_id, includeTabsContent: true })).data,
      meeting.notes_tab_id,
    );
    const out = await updateNotes(
      {
        orgName,
        transcriptBlocks: blocks,
        speakerNames: names,
        notesTabText: tab.paragraphs.map((p) => p.text).join("\n"),
        items: d.rows.filter((r) => !r.locked && !r.deleted_by_human).map(n.toNotesItem),
        locked: d.locked,
        deletedIds: d.deletedIds,
        final,
        nextId,
      },
      { client },
    );
    nextId = out.nextId;
    usd += out.usage.usd;
    const header = final ? `Avslutat ${clock().slice(0, 5)}` : `● LIVE · uppdaterad ${clock().slice(0, 5)}`;
    let status = "conflict";
    for (let attempt = 0; attempt <= 4 && status !== "ok"; attempt++) {
      if (attempt > 0) {
        await sleep(g.retryDelayMs());
        read = await n.readItems(auth, meeting.doc_id, meeting.notes_tab_id, rows);
        d = n.diffHumanEdits(rows, read.current, read.suggested);
      }
      const res = await n.renderItems(auth, meeting, d.rows, [...out.items, ...d.locked], read.revisionId, header);
      status = res.status;
      if (res.status === "ok") {
        rows = res.rows;
        if (res.headerRendered !== null) meeting.header_rendered = res.headerRendered;
      }
    }
    const lock = d.locked.length ? `, ${d.locked.length} låsta av dig` : "";
    const del = d.deletedIds.length ? `, ${d.deletedIds.length} raderade av dig` : "";
    console.log(
      `[${clock()}] ${final ? "slutpass" : `${mmss((t + 1) * tickMs)} mötestid`}: ${out.ops.length} ändringar, Doc ${status}${lock}${del} ($${out.usage.usd.toFixed(3)})`,
    );
    if (!final) await sleep(tickMs / speed - (Date.now() - t0));
  }
  console.log(`\nKlart. Claude-kostnad: $${usd.toFixed(2)}.\nhttps://docs.google.com/document/d/${meeting.doc_id}/edit`);
}

/** Notes tab (header range + section headings as anchor ranges) and a Transkript tab. */
async function createDoc(auth: OAuth2Client, g: typeof import("@/lib/google/docs"), title: string): Promise<MeetingRow> {
  const docs = g.docsApi(auth);
  const docId = (await docs.documents.create({ requestBody: { title } })).data.documentId!;
  const first = (await docs.documents.get({ documentId: docId, includeTabsContent: true })).data;
  const tabId = first.tabs?.[0]?.tabProperties?.tabId;
  if (!tabId) throw new Error("new doc has no tab");
  const id = randomUUID();
  const header = `ss-${id}-header`;
  const sectionRanges = Object.fromEntries(SECTIONS.map((x) => [x.section, `ss-${id}-sec-${x.section}`]));
  const lines = [{ name: header, text: "● LIVE · startar…" }, ...SECTIONS.map((x) => ({ name: sectionRanges[x.section], text: x.title }))];
  const requests: unknown[] = [
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
    });
    at += x.title.length + 1;
  }
  requests.push({ addDocumentTab: { tabProperties: { title: "Transkript" } } });
  const res = await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: requests as never } });
  const transcriptTab =
    (res.data.replies?.at(-1) as { addDocumentTab?: { tabProperties?: { tabId?: string } } } | undefined)?.addDocumentTab
      ?.tabProperties?.tabId ?? null;
  return {
    id,
    org_id: "demo",
    started_by: null,
    doc_id: docId,
    notes_tab_id: tabId,
    transcript_tab_id: transcriptTab,
    header_range: header,
    header_rendered: lines[0].text,
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
  } as MeetingRow;
}

main().catch((err) => {
  const e = err as { status?: number; message?: string };
  console.error("demo-live failed:", e.status ?? "", e.message ?? err);
  process.exit(1);
});
