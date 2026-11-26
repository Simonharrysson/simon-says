import type { docs_v1 } from "@googleapis/docs";
import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { INITIAL_LIVE_LINE, planAnchoring } from "@/lib/agenda/anchor";
import { fuzzyRoles } from "@/lib/agenda/roles";
import { anchoredStarts, itemAt, newAgendaItems, scanAgenda, withoutEarlierLines } from "@/lib/agenda/scan";
import type { CheckinWindow, ItemRole, MeetingRow, NoteItemRow, PersonRow } from "@/lib/db/types";
import { INITIAL_HEADER, SECTIONS } from "@/lib/docs/create";
import { planFormatRender, withoutOwnLines } from "@/lib/docs/format-render";
import { itemRangeName, planRender, renderedRows, toNotesItem } from "@/lib/docs/notes";
import { skeletonRequests, skeletonTableFill } from "@/lib/docs/skeleton";
import { parseNotesTab, type NotesTab } from "@/lib/docs/tab";
import { LEARN_SYSTEM_PROMPT } from "@/lib/formats/learn-prompt";
import { meetingRoles, type FormatProfile } from "@/lib/formats/schema";
import { rolesFromSkeleton, skeletonBlocks } from "@/lib/formats/skeleton";
import { STADGAR_SYSTEM_PROMPT } from "@/lib/formats/stadgar";
import { paragraphsWithRanges } from "@/lib/google/docs";
import {
  agendaContext,
  blocksForCall,
  checkinAnchor,
  claudeItems,
  copyProxies,
  desiredItems,
  endedHeader,
  formatDesired,
  hideCheckinText,
  liveHeader,
  readState,
  rekeyNewItems,
  serverItems,
  TID_ROW,
  unproxy,
  withOwnerIds,
} from "@/lib/meetings/tick";
import { NAMES_SYSTEM_PROMPT } from "@/lib/names/extract";
import { AGENDA_SYSTEM_PROMPT } from "@/lib/notes/agenda-prompt";
import { CHECKIN_SYSTEM_PROMPT } from "@/lib/notes/checkin";
import { updateNotes, type NotesClient, type UpdateNotesInput, type UpdateNotesResult } from "@/lib/notes/engine";
import { SYSTEM_PROMPT } from "@/lib/notes/prompt";
import type { RawAgendaOp, RawOp } from "@/lib/notes/schema";
import { ownerLabel, resolveOwner } from "@/lib/people/roles";
import { apply, docOf, paraEl, TAB } from "./docsim";
import { applyDoc, FMT_ENDED, FMT_STARTED } from "./formatdoc";

// The feature suite's meeting simulator (tests/suite): scripted Claude answers through the REAL
// engine code (a fake NotesClient behind updateNotes / extractNames / detectCheckin / the one-shot
// calls), rendered into docsim Docs by the real planners. `FormatSim` and `V1Sim` replay what
// lib/meetings/tick.ts runTick does per tick, minus the database (rows live in memory), so they run
// everywhere; the DB-gated suite tests call runTick itself with `scriptedClient`.
//
// A scripted client never reaches the API: a call whose prompt has no script throws.

type Doc = docs_v1.Schema$Document;

export type CallKind = "notes" | "checkin" | "names" | "learn" | "stadgar";

export interface ScriptedCall {
  kind: CallKind;
  body: BetaMessageStreamParams;
  /** The user message's text blocks, joined. */
  text: string;
}

/** Per call kind: the JSON answer for the n-th call of that kind (0-based). */
export type Script = Partial<Record<CallKind, (call: ScriptedCall, n: number) => unknown>>;

const KINDS: [string, CallKind][] = [
  [AGENDA_SYSTEM_PROMPT, "notes"],
  [SYSTEM_PROMPT, "notes"],
  [CHECKIN_SYSTEM_PROMPT, "checkin"],
  [NAMES_SYSTEM_PROMPT, "names"],
  [LEARN_SYSTEM_PROMPT, "learn"],
  [STADGAR_SYSTEM_PROMPT, "stadgar"],
];

export const answerMessage = (json: unknown): BetaMessage =>
  ({
    id: "msg_scripted",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: JSON.stringify(json), citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }) as unknown as BetaMessage;

/** A NotesClient that answers from `script`; every call is recorded in `calls`. */
export function scriptedClient(script: Script): { client: NotesClient; calls: ScriptedCall[] } {
  const calls: ScriptedCall[] = [];
  const counts = new Map<CallKind, number>();
  const client: NotesClient = {
    beta: {
      messages: {
        stream: (body: BetaMessageStreamParams) => ({
          finalMessage: async () => {
            const system = typeof body.system === "string" ? body.system : JSON.stringify(body.system);
            const kind = KINDS.find(([p]) => p === system)?.[1];
            if (!kind) throw new Error("scriptedClient: a Claude call with an unknown system prompt");
            const content = body.messages[0].content;
            const text = typeof content === "string" ? content : (content as { type: string; text?: string }[]).map((b) => b.text ?? "").join("\n");
            const call = { kind, body, text };
            calls.push(call);
            const handler = script[kind];
            if (!handler) throw new Error(`scriptedClient: unscripted ${kind} call`);
            const n = counts.get(kind) ?? 0;
            counts.set(kind, n + 1);
            return answerMessage(handler(call, n));
          },
        }),
      },
    },
  };
  return { client, calls };
}

/** A notes script: tick k (0-based) answers `ticks[k]` ops (none once the list runs out). */
export const notesTicks =
  (ticks: (RawAgendaOp | RawOp)[][]) =>
  (_call: ScriptedCall, n: number) => ({ ops: ticks[n] ?? [] });

/** One transcript block as the tick builds it: `[HH:MM:SS] S1-speaker_k: text`. */
export function block(lines: { at: number; speaker: number | string; text: string }[]): string {
  const ts = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, "0")).join(":");
  };
  return lines.map((l) => `[${ts(l.at)}] ${typeof l.speaker === "number" ? `S1-speaker_${l.speaker}` : l.speaker}: ${l.text}`).join("\n");
}

const person = (orgId: string, p: { name: string; role?: string | null; id?: string }, i: number): PersonRow => ({
  id: p.id ?? `p-${i + 1}`,
  org_id: orgId,
  name: p.name,
  member_user_id: null,
  role: p.role ?? null,
});

interface TickOpts {
  final?: boolean;
  /** Wall clock for the LIVE line (default 18:31 Stockholm). */
  now?: Date;
  /** Named speakers, as Närvarande shows them ("Anna Berg, Erik Lund"). */
  attendees?: string;
  /** The Må-runda window after this tick's detector (default: none). */
  window?: CheckinWindow | null;
  /** Let Claude ops be dropped by validation (default: a dropped op throws, so a bad script can't pass). */
  allowDropped?: boolean;
}

const NOW = new Date("2026-11-25T17:31:00Z"); // 18:31

abstract class Sim {
  rows: NoteItemRow[] = [];
  readonly results: UpdateNotesResult[] = [];
  readonly inputs: UpdateNotesInput[] = [];
  protected blocks: string[] = [];
  protected sentTick = 0;
  protected nextId: string | undefined;
  constructor(
    public doc: Doc,
    public meeting: MeetingRow,
    public people: PersonRow[],
    readonly client: NotesClient,
    readonly orgName: string,
    readonly speakerNames: Record<string, string>,
  ) {}

  lines(): string[] {
    return parseNotesTab(this.doc, TAB).paragraphs.map((p) => p.text.replace(/\n$/, ""));
  }

  tab(): NotesTab {
    return parseNotesTab(this.doc, TAB);
  }

  /** A human edit between ticks (Docs requests on the simulated Doc). */
  human(requests: docs_v1.Schema$Request[]): void {
    applyDoc(this.doc, requests);
  }

  protected async callClaude(input: UpdateNotesInput, allowDropped: boolean): Promise<UpdateNotesResult> {
    this.inputs.push(input);
    const out = await updateNotes(input, { client: this.client });
    this.results.push(out);
    if (out.failure !== null && !(allowDropped && out.failure === "all_dropped")) throw new Error(`sim: notes call failed (${out.failure})`);
    if (out.dropped && !allowDropped) throw new Error(`sim: ${out.dropped} scripted op(s) dropped by validation`);
    this.nextId = out.nextId;
    if (out.stopReason !== "error") this.sentTick = input.transcriptBlocks.length;
    return out;
  }
}

/**
 * A format-layout meeting (agenda Doc or a skeleton Doc), ticked as runTick's format branch does:
 * read → scan / agenda context (Må-runda text hidden) → updateNotes → re-read → formatDesired with
 * the server rows → planFormatRender → apply → renderedRows + owner ids.
 */
export class FormatSim extends Sim {
  profile!: FormatProfile;
  /** Agenda Testmöte (A13): the fixture's people label owners, no owner ids are stored. */
  testPeople = false;

  /**
   * Anchor `doc` for meeting `id` as the start does (planAnchoring on a scan without earlier
   * lines), roles from `roles` (else the skeleton's, else fuzzy matching), then pre-render `carried`
   * rows (Från förra veckan) as the start's prefill does.
   */
  static start(opts: {
    id: string;
    doc: Doc;
    profile: FormatProfile;
    script: Script | NotesClient;
    people?: { name: string; role?: string | null; id?: string }[];
    roles?: Record<string, ItemRole>;
    orgId?: string;
    orgName?: string;
    startedAt?: Date;
    carried?: NoteItemRow[];
    speakerNames?: Record<string, string>;
  }): FormatSim {
    const startedAt = opts.startedAt ?? FMT_STARTED;
    const tab = parseNotesTab(opts.doc, TAB);
    const scan = scanAgenda(withoutEarlierLines(tab), opts.profile);
    const plan = planAnchoring(scan, tab, { meetingId: opts.id, profile: opts.profile, startedAt });
    applyDoc(opts.doc, plan.requests);
    // As the start: the Må-runda keeps its checkin role only when the format opts in (meetingRoles).
    const roles = meetingRoles(opts.roles ?? fuzzyRoles(scan.items, opts.profile.fixedAgendaItems), opts.profile);
    const meeting = {
      id: opts.id,
      org_id: opts.orgId ?? "o",
      doc_id: `doc-${opts.id}`,
      notes_tab_id: TAB,
      header_range: plan.headerRange,
      header_rendered: INITIAL_LIVE_LINE,
      section_ranges: plan.sectionRanges,
      agenda_roles: roles,
      layout: "format",
      status: "live",
      started_at: startedAt.toISOString(),
      ended_at: null,
    } as unknown as MeetingRow;
    const client = "beta" in opts.script ? opts.script : scriptedClient(opts.script).client;
    const people = (opts.people ?? []).map((p, i) => person(meeting.org_id, p, i));
    const sim = new FormatSim(opts.doc, meeting, people, client, opts.orgName ?? "Föreningen", opts.speakerNames ?? {});
    sim.profile = opts.profile;
    sim.rows = plan.rows.map((r) => ({ ...r, meeting_id: opts.id }));
    if (opts.carried?.length) {
      const carried = opts.carried.map((r) => ({ ...r, meeting_id: opts.id }));
      const all = [...sim.rows, ...carried];
      const tab2 = parseNotesTab(sim.doc, TAB);
      const p = planFormatRender(meeting, tab2, all, all.map(toNotesItem), { profile: sim.profile, ownerLabel: sim.ownerLabel });
      applyDoc(sim.doc, p.requests);
      sim.rows = renderedRows(opts.id, all, all.map(toNotesItem), p);
    }
    return sim;
  }

  /** A new Doc in `profile` (the fallback: skeleton, both batches), anchored with the skeleton's roles. */
  static skeleton(opts: Omit<Parameters<typeof FormatSim.start>[0], "doc" | "roles">): FormatSim {
    const doc = docOf([paraEl("")]);
    const blocks = skeletonBlocks(opts.profile);
    apply(doc, skeletonRequests(TAB, blocks, opts.profile.numbering));
    apply(doc, skeletonTableFill(parseNotesTab(doc, TAB), blocks));
    return FormatSim.start({ ...opts, doc, roles: rolesFromSkeleton(opts.profile) });
  }

  get groupBy(): "role" | "person" {
    return this.profile.tasksSection?.groupBy ?? "person";
  }

  readonly ownerLabel = (owner: string) => ownerLabel(resolveOwner(owner, this.people), owner, this.groupBy);

  async tick(blockText: string | null, opts: TickOpts = {}): Promise<UpdateNotesResult | null> {
    const final = opts.final ?? false;
    if (blockText !== null) this.blocks.push(blockText);
    if (final) this.meeting.ended_at ??= FMT_ENDED.toISOString();
    const m = this.meeting;
    const tab = this.tab();
    const scan = scanAgenda(withoutOwnLines(tab, this.rows), this.profile, { anchors: anchoredStarts(tab, m.section_ranges ?? {}, m.id) });
    const fresh = newAgendaItems(scan, tab, m.section_ranges ?? {}, m.id).map((n) => ({ ...n, label: itemAt(scan, n.start)?.label ?? "" }));
    const hidden = hideCheckinText(tab, scan, m, agendaContext(tab, scan, m, this.profile, this.people, fresh));
    const first = { ...readState(tab, this.rows), text: hidden.text };
    const proxies = copyProxies(first.diff.rows);
    let items = [...claudeItems(first.items), ...proxies.items];
    const send = blocksForCall(this.blocks, this.sentTick);
    let out: UpdateNotesResult | null = null;
    if (send.length > 0 && (final || send.length > this.sentTick)) {
      out = await this.callClaude(
        {
          orgName: this.orgName,
          transcriptBlocks: send,
          speakerNames: this.speakerNames,
          notesTabText: first.text,
          items,
          locked: claudeItems(first.diff.locked).filter((i) => !proxies.proxied.has(i.id)),
          deletedIds: first.diff.deletedIds.filter((id) => !proxies.proxied.has(id)),
          final,
          nextId: this.nextId,
          agenda: hidden.agenda,
          ownLines: first.diff.rows.filter((r) => !r.locked && !r.deleted_by_human && r.last_rendered_text).map((r) => r.last_rendered_text!),
        },
        opts.allowDropped ?? false,
      );
      items = out.items;
    }
    // Re-read right before the write, as the tick does.
    const tab2 = this.tab();
    const st = readState(tab2, this.rows);
    const ranges = m.section_ranges ?? {};
    const scan2 = scanAgenda(withoutOwnLines(tab2, st.diff.rows), this.profile, { anchors: anchoredStarts(tab2, ranges, m.id) });
    const agendaKeys = Object.keys(ranges).filter((k) => /^ag-\d+$/.test(k));
    const newAnchors = rekeyNewItems(newAgendaItems(scan2, tab2, ranges, m.id), scan2, fresh, agendaKeys);
    const server = serverItems({
      attendees: opts.attendees ?? "",
      window: opts.window ?? null,
      checkinKey: checkinAnchor(m),
      tidRow: this.rows.some((r) => r.id === TID_ROW),
      final,
      startedAt: new Date(m.started_at),
      endedAt: m.ended_at ? new Date(m.ended_at) : FMT_ENDED,
    });
    const desired = formatDesired(unproxy(items, proxies.proxied), st.diff, server, this.profile);
    const header = final ? endedHeader(new Date(m.ended_at!), "format") : liveHeader(opts.now ?? NOW, "format");
    const plan = planFormatRender(m, tab2, st.diff.rows, desired, { profile: this.profile, ownerLabel: this.ownerLabel, headerText: header, newAnchors });
    applyDoc(this.doc, plan.requests);
    if (newAnchors.length) {
      m.section_ranges = { ...ranges, ...Object.fromEntries(newAnchors.map((a) => [a.key, itemRangeName(m.id, a.key)])) };
      m.agenda_roles = { ...m.agenda_roles, ...Object.fromEntries(newAnchors.map((a) => [a.key, "topic" as const])) };
    }
    this.rows = withOwnerIds(renderedRows(m.id, st.diff.rows, desired, plan), this.testPeople ? [] : this.people);
    if (plan.header !== null) m.header_rendered = plan.header;
    if (final) m.status = "done";
    return out;
  }
}

/** The v1 layout (Enkel, no agenda): today's Doc with the four sections, ticked as runTick's v1 branch. */
export class V1Sim extends Sim {
  static start(opts: {
    id: string;
    script: Script | NotesClient;
    people?: { name: string; role?: string | null }[];
    orgName?: string;
    speakerNames?: Record<string, string>;
  }): V1Sim {
    const doc = docOf([paraEl("")]);
    const headerRange = `ss-${opts.id}-header`;
    const sectionRanges = Object.fromEntries(SECTIONS.map((s) => [s.section, `ss-${opts.id}-sec-${s.section}`]));
    apply(doc, paragraphsWithRanges(TAB, 1, [{ name: headerRange, text: INITIAL_HEADER }, ...SECTIONS.map((s) => ({ name: sectionRanges[s.section], text: s.title }))]));
    const meeting = {
      id: opts.id,
      org_id: "o",
      doc_id: `doc-${opts.id}`,
      notes_tab_id: TAB,
      header_range: headerRange,
      header_rendered: INITIAL_HEADER,
      section_ranges: sectionRanges,
      layout: "v1",
      status: "live",
      started_at: FMT_STARTED.toISOString(),
      ended_at: null,
    } as unknown as MeetingRow;
    const client = "beta" in opts.script ? opts.script : scriptedClient(opts.script).client;
    return new V1Sim(doc, meeting, (opts.people ?? []).map((p, i) => person("o", p, i)), client, opts.orgName ?? "Föreningen", opts.speakerNames ?? {});
  }

  async tick(blockText: string | null, opts: Pick<TickOpts, "final" | "now" | "allowDropped"> = {}): Promise<UpdateNotesResult | null> {
    const final = opts.final ?? false;
    if (blockText !== null) this.blocks.push(blockText);
    if (final) this.meeting.ended_at ??= FMT_ENDED.toISOString();
    const first = readState(this.tab(), this.rows, { cells: false });
    let items = first.items;
    const send = blocksForCall(this.blocks, this.sentTick);
    let out: UpdateNotesResult | null = null;
    if (send.length > 0 && (final || send.length > this.sentTick)) {
      out = await this.callClaude(
        {
          orgName: this.orgName,
          transcriptBlocks: send,
          speakerNames: this.speakerNames,
          notesTabText: first.text,
          items: first.items,
          locked: first.diff.locked,
          deletedIds: first.diff.deletedIds,
          final,
          nextId: this.nextId,
        },
        opts.allowDropped ?? false,
      );
      items = out.items;
    }
    const tab2 = this.tab();
    const st = readState(tab2, this.rows);
    const header = final ? endedHeader(new Date(this.meeting.ended_at!)) : liveHeader(opts.now ?? NOW);
    const desired = desiredItems(items, st.diff);
    const plan = planRender(this.meeting, tab2, st.diff.rows, desired, header);
    applyDoc(this.doc, plan.requests);
    this.rows = renderedRows(this.meeting.id, st.diff.rows, desired, plan);
    if (plan.header !== null) this.meeting.header_rendered = plan.header;
    if (final) this.meeting.status = "done";
    return out;
  }
}
