import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuth2Client } from "google-auth-library";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import type { MeetingRow, NoteItemRow } from "@/lib/db/types";
import type { NotesTab, RenderResult } from "@/lib/docs/notes";
import type { TranscriptLine } from "@/lib/docs/transcript";
import type { UpdateNotesInput, UpdateNotesResult } from "@/lib/notes/engine";
import type { NotesItem } from "@/lib/notes/schema";

const current = vi.hoisted(() => ({ db: null as import("@supabase/supabase-js").SupabaseClient | null }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => current.db }));

type EnvOverride = { KILL_SWITCH?: boolean; GLOBAL_DAILY_HOURS?: number; GLOBAL_DAILY_USD?: number };
const envOverride = vi.hoisted(() => ({}) as EnvOverride);
vi.mock("@/lib/env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/env")>();
  const { testEnv } = await import("@/test/env");
  const base = mod.parseEnv({
    ...testEnv,
    SUPABASE_URL: process.env.LOCAL_SUPABASE_API_URL ?? "http://127.0.0.1:54321",
    SUPABASE_ANON_KEY: process.env.LOCAL_SUPABASE_ANON_KEY ?? "anon",
    SUPABASE_SERVICE_ROLE_KEY: process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY ?? "service",
  });
  return { ...mod, getEnv: () => ({ ...base, ...envOverride }) };
});

const tick = await import("@/lib/meetings/tick");
const { renderedRows, itemRangeName } = await import("@/lib/docs/notes");
const { GoogleAuthLostError } = await import("@/lib/google/client");
const { ingestSegments } = await import("@/lib/segments/ingest");
const { createOrg } = await import("@/lib/db/orgs");
const { POST: postEnd } = await import("@/app/api/meetings/[id]/end/route");
const { GET: getFinalize } = await import("@/app/api/cron/finalize/route");
const { NextRequest } = await import("next/server");

// ---------------------------------------------------------------------------------------------
// Pure parts (run everywhere)

const seg = (over: Partial<import("@/lib/meetings/tick").SegmentRead>): import("@/lib/meetings/tick").SegmentRead => ({
  el_session_id: "sess-a",
  segment_index: 0,
  run_index: 0,
  speaker: "speaker_0",
  text: "hej",
  start_ms: 0,
  tick_no: 1,
  transcript_written_at: null,
  ...over,
});

/** A notes tab where each row is one paragraph covered exactly by its named range. */
function tabOf(
  meetingId: string,
  rows: Pick<NoteItemRow, "id" | "range_name" | "last_rendered_text">[],
  opts: { revisionId?: string; text?: Record<string, string | null>; shrink?: string[] } = {},
): NotesTab {
  const paragraphs: NotesTab["paragraphs"] = [];
  const ranges: NotesTab["ranges"] = new Map();
  let at = 1;
  const push = (text: string, name?: string, shrink = false) => {
    paragraphs.push({ start: at, end: at + text.length + 1, text: `${text}\n`, suggested: false });
    if (name) ranges.set(name, [[{ start: at, end: at + text.length - (shrink ? 1 : 0) }]]);
    at += text.length + 1;
  };
  push("● LIVE · uppdaterad –", `ss-${meetingId}-header`);
  for (const r of rows) {
    const t = opts.text && r.id in opts.text ? opts.text[r.id] : r.last_rendered_text;
    if (t === null) continue; // range and paragraph deleted
    push(t ?? "", r.range_name ?? undefined, opts.shrink?.includes(r.id));
  }
  return { revisionId: opts.revisionId ?? "rev", tabId: "t.notes", paragraphs, ranges };
}

const row = (over: Partial<NoteItemRow> & { id: string }): NoteItemRow => ({
  meeting_id: "m",
  section: "decision",
  text: `text ${over.id}`,
  owner: null,
  due: null,
  locked: false,
  deleted_by_human: false,
  last_rendered_text: `✓ text ${over.id}`,
  range_name: `ss-m-${over.id}`,
  position: 0,
  ...over,
});

describe("headers and time", () => {
  it("formats Europe/Stockholm HH:mm in winter and summer", () => {
    expect(tick.stockholmTime(new Date("2026-11-24T13:05:00Z"))).toBe("14:05");
    expect(tick.stockholmTime(new Date("2026-07-01T22:30:00Z"))).toBe("00:30");
  });
  it("live and ended header lines", () => {
    expect(tick.liveHeader(new Date("2026-11-24T13:05:00Z"))).toBe("● LIVE · uppdaterad 14:05");
    expect(tick.endedHeader(new Date("2026-11-24T15:59:00Z"))).toBe("Avslutat 16:59");
  });
  it("tickDue: 45 s target", () => {
    const now = new Date("2026-11-24T12:00:45Z");
    expect(tick.tickDue(null, now)).toBe(true);
    expect(tick.tickDue("2026-11-24T12:00:00Z", now)).toBe(true);
    expect(tick.tickDue("2026-11-24T12:00:01Z", now)).toBe(false);
  });
});

describe("buildTranscript", () => {
  const sessions = [
    { id: "sess-b", started_at: "2026-11-24T12:10:00Z" },
    { id: "sess-a", started_at: "2026-11-24T12:00:00Z" },
  ];
  it("one block per tick, raw S<n>-<label> lines in a fixed order", () => {
    const { blocks } = tick.buildTranscript(
      [
        seg({ tick_no: 2, el_session_id: "sess-b", start_ms: 700_000, text: "andra" }),
        seg({ tick_no: 1, start_ms: 2000, segment_index: 1, speaker: "speaker_1", text: "två" }),
        seg({ tick_no: 1, start_ms: 1000, text: "ett\nrad" }),
      ],
      sessions,
      [],
    );
    expect(blocks).toEqual([
      "[00:00:01] S1-speaker_0: ett rad\n[00:00:02] S1-speaker_1: två",
      "[00:11:40] S2-speaker_0: andra",
    ]);
  });
  it("a late segment joins the next block; earlier blocks stay byte-identical", () => {
    const first = tick.buildTranscript([seg({ start_ms: 5000 })], sessions, []).blocks;
    const later = tick.buildTranscript(
      [seg({ start_ms: 5000 }), seg({ tick_no: 2, start_ms: 1000, segment_index: 9, text: "sent" })],
      sessions,
      [],
    ).blocks;
    expect(later[0]).toBe(first[0]);
    expect(later[1]).toBe("[00:00:01] S1-speaker_0: sent");
  });
  it("names come through merges; blocks keep the raw label", () => {
    const speakers = [
      { el_session_id: "sess-a", speaker_label: "speaker_1", display_name: "speaker_1", merged_into_label: "speaker_0" },
      { el_session_id: "sess-a", speaker_label: "speaker_0", display_name: "Anna", person_id: null },
    ];
    const out = tick.buildTranscript(
      [seg({}), seg({ speaker: "speaker_1", segment_index: 1, start_ms: 10 }), seg({ speaker: "speaker_2", segment_index: 2, start_ms: 20 })],
      sessions,
      speakers,
    );
    expect(out.blocks[0]).toContain("S1-speaker_1: hej");
    expect(out.speakerNames).toEqual({ "S1-speaker_0": "Anna", "S1-speaker_1": "Anna" });
    const lines = tick.transcriptLines(
      [seg({}), seg({ speaker: "speaker_1", segment_index: 1, start_ms: 10 }), seg({ speaker: "speaker_2", segment_index: 2, start_ms: 20 })],
      sessions,
      speakers,
    );
    expect(lines.map((l) => l.speaker)).toEqual(["Anna", "Anna", "S1-speaker_2"]);
  });
  it("transcriptLines: only unwritten, assigned segments", () => {
    const lines = tick.transcriptLines(
      [seg({ transcript_written_at: "2026-11-24T12:00:00Z" }), seg({ segment_index: 1, start_ms: 3000, text: "ny" })],
      sessions,
      [],
    );
    expect(lines).toEqual([{ speaker: "S1-speaker_0", atMs: 3000, text: "ny" }]);
  });
});

describe("blocksForCall", () => {
  it("never more than 20 new blocks after the last sent one", () => {
    const blocks = Array.from({ length: 30 }, (_, i) => `b${i + 1}`);
    expect(tick.blocksForCall(blocks, 0)).toHaveLength(20);
    expect(tick.blocksForCall(blocks, 5)).toHaveLength(25);
    expect(tick.blocksForCall(blocks, 28)).toHaveLength(30);
  });
});

describe("retireFrozenNow (Ruling 17)", () => {
  it("drops a 'now' row whose range no longer covers its whole line, keeps the rest", () => {
    const rows = [row({ id: "n1" }), row({ id: "n2", section: "now", last_rendered_text: "Budget" })];
    expect(tick.retireFrozenNow(tabOf("m", rows), rows).map((r) => r.id)).toEqual(["n1", "n2"]);
    expect(tick.retireFrozenNow(tabOf("m", rows, { shrink: ["n2"] }), rows).map((r) => r.id)).toEqual(["n1"]);
    // Only "now" rows are retired: a shrunk decision stays (the render guard skips it).
    expect(tick.retireFrozenNow(tabOf("m", rows, { shrink: ["n1"] }), rows).map((r) => r.id)).toEqual(["n1", "n2"]);
  });
});

describe("readState + desiredItems", () => {
  it("drops Claude's version of an item a human locked or deleted since, keeps the human's", () => {
    const rows = [row({ id: "n1" }), row({ id: "n2" }), row({ id: "n3" })];
    const claude: NotesItem[] = [
      { id: "n1", section: "decision", text: "claude n1" },
      { id: "n2", section: "decision", text: "claude n2" },
      { id: "n3", section: "decision", text: "claude n3" },
      { id: "n4", section: "action", text: "ny" },
    ];
    const st = tick.readState(tabOf("m", rows, { text: { n1: "✓ människa", n2: null } }), rows);
    expect(st.diff.locked.map((i) => i.id)).toEqual(["n1"]);
    expect(st.diff.deletedIds).toEqual(["n2"]);
    expect(tick.desiredItems(claude, st.diff)).toEqual([
      { id: "n3", section: "decision", text: "claude n3" },
      { id: "n4", section: "action", text: "ny" },
      { id: "n1", section: "decision", text: "✓ människa" },
    ]);
  });
});

describe("cron route", () => {
  it("401 without the cron secret", async () => {
    expect((await getFinalize(new Request("https://x.test/api/cron/finalize"))).status).toBe(401);
    const wrong = new Request("https://x.test/api/cron/finalize", { headers: { authorization: "Bearer nope" } });
    expect((await getFinalize(wrong)).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------
// Against the local stack (CI)

describe.skipIf(!hasLocalSupabase)("ticks, end and finalize", () => {
  let starter: TestUser;
  let orgId: string;

  beforeAll(async () => {
    starter = await createTestUser("ticker");
    const r = await createOrg(starter.db, "Tickföreningen");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
  });

  beforeEach(() => {
    for (const k of Object.keys(envOverride)) delete envOverride[k as keyof EnvOverride];
    envOverride.GLOBAL_DAILY_HOURS = 1_000_000;
    envOverride.GLOBAL_DAILY_USD = 1_000_000;
  });

  async function meeting(opts: { heartbeatAgoSec?: number | null; transcript?: boolean } = {}) {
    const admin = adminClient();
    const id = randomUUID();
    const hb = opts.heartbeatAgoSec === undefined ? 0 : opts.heartbeatAgoSec;
    // Meeting and session start together, so session-relative times are meeting-relative.
    const startedAt = new Date(Date.now() - 600_000).toISOString();
    const { error } = await admin.from("meetings").insert({
      id,
      org_id: orgId,
      started_by: starter.id,
      doc_id: `doc-${id}`,
      notes_tab_id: "t.notes",
      transcript_tab_id: opts.transcript === false ? null : "t.transcript",
      header_range: `ss-${id}-header`,
      header_rendered: "● LIVE · uppdaterad –",
      status: "live",
      consent_confirmed_at: new Date().toISOString(),
      started_at: startedAt,
      last_heartbeat_at: hb === null ? null : new Date(Date.now() - hb * 1000).toISOString(),
    });
    if (error) throw new Error(error.message);
    const sessionId = `el-${randomUUID()}`;
    const { error: se } = await admin
      .from("el_sessions")
      .insert({ id: sessionId, meeting_id: id, max_seconds: 3600, started_at: startedAt });
    if (se) throw new Error(se.message);
    await admin.from("meetings").update({ current_el_session_id: sessionId }).eq("id", id);
    return { id, sessionId };
  }

  let segCounter = 0;
  const say = (meetingId: string, sessionId: string, text: string, startMs: number) =>
    ingestSegments(meetingId, [
      { elSessionId: sessionId, segmentIndex: segCounter++, runIndex: 0, speaker: "speaker_0", text, startMs, endMs: startMs + 500 },
    ]);

  /** Fake Google + Claude, with the Doc state derived from note_items (+ human overrides). */
  function fakes(
    opts: {
      conflicts?: number;
      gate?: Promise<void>;
      authLost?: () => boolean;
      readFails?: () => boolean;
      claudeError?: boolean;
      /** Claude answers without usable ops: "refusal", "stop:max_tokens", "malformed", "all_dropped". */
      nonAnswer?: () => string | null;
      /** An end_turn answer with zero ops. */
      quiet?: boolean;
      onUpdate?: (input: UpdateNotesInput) => Promise<void>;
      /** The name round's Claude call (default: no names). */
      names?: import("@/lib/names/round").ExtractFn;
    } = {},
  ) {
    // A clock that fake sleeps move forward (deadline loops end without real waiting).
    let offset = 0;
    const calls: UpdateNotesInput[] = [];
    const headers: (string | undefined)[] = [];
    const appended: TranscriptLine[][] = [];
    const mails: string[] = [];
    let conflicts = opts.conflicts ?? 0;
    let renders = 0;
    const deps: Partial<import("@/lib/meetings/tick").TickDeps> = {
      getAuth: async (userId) => {
        if (opts.authLost?.()) throw new GoogleAuthLostError(userId, "invalid_grant");
        return {} as OAuth2Client;
      },
      readNotes: async (_auth, m: MeetingRow) => {
        if (opts.readFails?.()) throw new Error("docs 500");
        const { data } = await adminClient().from("note_items").select("*").eq("meeting_id", m.id).order("position");
        return tabOf(m.id, (data ?? []) as NoteItemRow[], { revisionId: `r${renders}` });
      },
      render: async (_auth, m, rows, desired, _rev, header): Promise<RenderResult> => {
        renders++;
        headers.push(header);
        if (conflicts > 0) {
          conflicts--;
          return { status: "conflict" };
        }
        const ids = new Set(desired.map((d) => d.id));
        const applied = new Set(
          desired.filter((d) => !rows.find((r) => r.id === d.id && (r.locked || r.deleted_by_human))).map((d) => d.id),
        );
        const removed = new Set(rows.filter((r) => !ids.has(r.id) && !r.locked && !r.deleted_by_human).map((r) => r.id));
        return { status: "ok", rows: renderedRows(m.id, rows, desired, { applied, removed }), headerRendered: header ?? null };
      },
      appendTranscript: async (_auth, _doc, _tab, lines) => {
        appended.push(lines);
      },
      extractNames: opts.names ?? (async () => []),
      updateNotes: async (input): Promise<UpdateNotesResult> => {
        calls.push(input);
        if (opts.gate) await opts.gate;
        if (opts.onUpdate) await opts.onUpdate(input);
        if (opts.claudeError) {
          return {
            ops: [],
            items: input.items,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, estimated: true },
            stopReason: "error",
            dropped: 0,
            nextId: input.nextId ?? "n1",
            failure: "error",
          };
        }
        const non = opts.nonAnswer?.() ?? null;
        if (non || opts.quiet) {
          return {
            ops: [],
            items: input.items,
            usage: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, usd: 0.005 },
            stopReason: non === "refusal" ? "refusal" : non?.startsWith("stop:") ? non.slice(5) : "end_turn",
            dropped: non === "all_dropped" ? 2 : 0,
            nextId: input.nextId ?? "n1",
            failure: non,
          };
        }
        const n = Number((input.nextId ?? "n1").slice(1));
        const add: NotesItem = { id: `n${n}`, section: "decision", text: `Beslut ${n}` };
        return {
          ops: [{ op: "add", item: add }],
          items: [...input.items, add],
          usage: { input: 1000, output: 100, cacheRead: 50, cacheWrite: 10, usd: 0.01 },
          stopReason: "end_turn",
          dropped: 0,
          nextId: `n${n + 1}`,
          failure: null,
        };
      },
      mailer: {
        send: async (msg) => {
          mails.push(msg.subject);
          return false;
        },
      },
      sleep: async (ms) => {
        offset += ms;
      },
      now: () => new Date(Date.now() + offset),
    };
    return { deps, calls, headers, appended, mails, renders: () => renders };
  }

  const read = async (id: string) =>
    (await adminClient().from("meetings").select("*").eq("id", id).single()).data as MeetingRow & {
      notes_next_id: string | null;
    };
  const events = async (id: string, kind: string) =>
    (await adminClient().from("meeting_events").select("kind, detail").eq("meeting_id", id).eq("kind", kind)).data ?? [];
  const backdate = (id: string, sec = 46) =>
    adminClient().from("meetings").update({ last_tick_at: new Date(Date.now() - sec * 1000).toISOString() }).eq("id", id);

  it("a tick: blocks to Claude, notes saved, header + counter + usage persisted, transcript appended", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "Vi bestämmer budgeten", 1000);
    const f = fakes();
    const { data: before } = await adminClient().from("usage_daily").select("claude_input_tokens").eq("org_id", orgId);
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].transcriptBlocks).toEqual(["[00:00:01] S1-speaker_0: Vi bestämmer budgeten"]);
    expect(f.calls[0].orgName).toBe("Tickföreningen");
    expect(f.headers[0]).toMatch(/^● LIVE · uppdaterad \d\d:\d\d$/);
    const m = await read(id);
    expect(m.notes_next_id).toBe("n2");
    expect(m.header_rendered).toBe(f.headers[0]);
    expect(m.tick_lease_until).toBeNull();
    expect(m.failed_ticks).toBe(0);
    expect(m.last_tick_ok_at).not.toBeNull();
    const { data: items } = await adminClient().from("note_items").select("id, range_name").eq("meeting_id", id);
    expect(items).toEqual([{ id: "n1", range_name: itemRangeName(id, "n1") }]);
    expect(f.appended).toEqual([[{ speaker: "S1-speaker_0", atMs: 1000, text: "Vi bestämmer budgeten" }]]);
    const { data: segs } = await adminClient().from("segments").select("tick_no, transcript_written_at").eq("meeting_id", id);
    expect(segs?.[0].tick_no).toBe(1);
    expect(segs?.[0].transcript_written_at).not.toBeNull();
    const { data: after } = await adminClient().from("usage_daily").select("claude_input_tokens").eq("org_id", orgId);
    const sum = (rows: { claude_input_tokens: number }[] | null) => (rows ?? []).reduce((s, r) => s + Number(r.claude_input_tokens), 0);
    expect(sum(after) - sum(before)).toBe(1000);
    expect(await events(id, "tick_ok")).toHaveLength(1);
  });

  it("concurrent runTick: one ok, one busy", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "hej", 1000);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const f = fakes({ gate });
    const first = tick.runTick(id, { final: false }, f.deps);
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("busy");
    open();
    expect(await first).toBe("ok");
  });

  it("two ticks 45 s apart both run (lease released); within 30 s skipped", async () => {
    const { id, sessionId } = await meeting();
    const f = fakes();
    await say(id, sessionId, "ett", 1000);
    await tick.maybeTick(id, f.deps);
    expect(f.calls).toHaveLength(1);
    await say(id, sessionId, "två", 2000);
    await tick.maybeTick(id, f.deps); // right after: skipped
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("busy"); // hard floor 30 s
    expect(f.calls).toHaveLength(1);
    await backdate(id, 46);
    await tick.maybeTick(id, f.deps);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].nextId).toBe("n2");
  });

  it("late segments get the next tick_no; earlier blocks unchanged", async () => {
    const { id, sessionId } = await meeting();
    const f = fakes();
    await say(id, sessionId, "först", 5000);
    await tick.runTick(id, { final: false }, f.deps);
    await say(id, sessionId, "sen", 1000); // earlier start time, arrives later
    await backdate(id);
    await tick.runTick(id, { final: false }, f.deps);
    expect(f.calls[1].transcriptBlocks[0]).toBe(f.calls[0].transcriptBlocks[0]);
    expect(f.calls[1].transcriptBlocks[1]).toBe("[00:00:01] S1-speaker_0: sen");
  });

  it("conflict: 1 + 4 retries, then skipped with a tick_conflict event", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "hej", 1000);
    const f = fakes({ conflicts: 99 });
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("conflict");
    expect(f.renders()).toBe(5);
    expect(await events(id, "tick_conflict")).toHaveLength(1);
    const m = await read(id);
    expect(m.failed_ticks).toBe(0);
    expect(m.notes_next_id).toBe("n2"); // ids handed out are never reissued
    const { data: items } = await adminClient().from("note_items").select("id").eq("meeting_id", id);
    expect(items).toEqual([]);
  });

  it("3 failed ticks in a row → one alarm email (once per hour)", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "hej", 1000);
    const f = fakes({ readFails: () => true });
    for (let i = 0; i < 4; i++) {
      await backdate(id);
      expect(await tick.runTick(id, { final: false }, f.deps)).toBe("failed");
    }
    expect((await read(id)).failed_ticks).toBe(4);
    expect(await events(id, "tick_failed")).toHaveLength(4);
    expect(await events(id, "alarm")).toHaveLength(1);
    expect(f.mails).toHaveLength(1);
    // Failed before Claude answered: the tick number is given back.
    const { data: segs } = await adminClient().from("segments").select("tick_no").eq("meeting_id", id);
    expect(segs?.[0].tick_no).toBeNull();
  });

  it.each(["refusal", "stop:max_tokens", "malformed", "all_dropped"])(
    "Claude non-answer (%s) is a failed tick: no last_tick_ok_at, failed_ticks++, alarm at 3; transcript still written, blocks not resent",
    async (reason) => {
      const { id, sessionId } = await meeting();
      await say(id, sessionId, "hej", 1000);
      const f = fakes({ nonAnswer: () => reason });
      for (let i = 0; i < 3; i++) {
        await backdate(id);
        if (i > 0) await say(id, sessionId, `mer ${i}`, 2000 + i * 1000);
        expect(await tick.runTick(id, { final: false }, f.deps)).toBe("failed");
      }
      const m = await read(id);
      expect(m.last_tick_ok_at).toBeNull();
      expect(m.failed_ticks).toBe(3);
      const failed = await events(id, "tick_failed");
      expect(failed).toHaveLength(3);
      expect(JSON.stringify(failed[0].detail)).toContain(reason);
      expect(await events(id, "tick_ok")).toHaveLength(0);
      expect(await events(id, "alarm")).toHaveLength(1);
      // The blocks were sent: notes_sent_tick moved on, so each call only carries one new block.
      expect(f.calls.map((c) => c.transcriptBlocks.length)).toEqual([1, 2, 3]);
      expect((await read(id)).notes_sent_tick).toBe(3);
      // The transcript keeps flowing; the notes write (and its LIVE header) is skipped.
      expect(f.appended.flat().map((l) => l.text)).toEqual(["hej", "mer 1", "mer 2"]);
      expect(f.renders()).toBe(0);
    },
  );

  it("an end_turn answer with zero ops is an ok tick (a quiet stretch)", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "hej", 1000);
    const f = fakes({ quiet: true });
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    const m = await read(id);
    expect(m.last_tick_ok_at).not.toBeNull();
    expect(m.failed_ticks).toBe(0);
  });

  it("a stale tick whose lease moved on saves no rows (B2)", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "hej", 1000);
    await adminClient()
      .from("note_items")
      .insert({ meeting_id: id, id: "n9", section: "decision", text: "Nyare ticks rad", range_name: itemRangeName(id, "n9") });
    // While Claude thinks, the lease expires and a newer tick takes it.
    const f = fakes({
      onUpdate: async () => {
        await adminClient().from("meetings").update({ tick_lease_id: randomUUID() }).eq("id", id);
      },
    });
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("busy");
    const { data: items } = await adminClient().from("note_items").select("id").eq("meeting_id", id);
    expect(items).toEqual([{ id: "n9" }]);
  });

  it("the tick lease is 6 minutes", async () => {
    const { id } = await meeting();
    const { data } = await adminClient().rpc("claim_tick_lease", { p_meeting_id: id, p_min_interval_secs: 0 });
    expect(data[0].result).toBe("ok");
    const m = await read(id);
    const ms = Date.parse(m.tick_lease_until!) - Date.now();
    expect(ms).toBeGreaterThan(5.5 * 60_000);
    expect(ms).toBeLessThanOrEqual(6 * 60_000 + 5000);
  });

  it("a final pass that must skip Claude with transcript unsent logs final_without_claude", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "hej", 1000);
    const f = fakes();
    await adminClient().from("meetings").update({ status: "ending" }).eq("id", id);
    // 10 s left: below the 30 s Claude needs.
    const deadlineAt = new Date(Date.now() + 10_000);
    expect(await tick.runTick(id, { final: true, deadlineAt }, f.deps)).toBe("ok");
    expect(f.calls).toHaveLength(0);
    expect(await events(id, "final_without_claude")).toHaveLength(1);
    expect(await events(id, "tick_ok")).toHaveLength(0);
    // Don't leave an `ending` meeting for later sweeps in this org.
    await adminClient().from("meetings").update({ status: "done" }).eq("id", id);
  });

  it("GoogleAuthLostError → paused, segments untouched; resumed by cron after a token update", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "hej", 1000);
    let lost = true;
    const f = fakes({ authLost: () => lost });
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("doc_paused");
    const paused = await read(id);
    expect(paused.doc_paused_at).not.toBeNull();
    expect(await events(id, "doc_paused")).toHaveLength(1);
    const { data: segs } = await adminClient().from("segments").select("tick_no, transcript_written_at").eq("meeting_id", id);
    expect(segs).toEqual([{ tick_no: null, transcript_written_at: null }]);
    await backdate(id);
    await tick.maybeTick(id, f.deps); // paused: nothing
    expect(f.calls).toHaveLength(0);

    lost = false;
    await adminClient()
      .from("google_tokens")
      .upsert({ user_id: starter.id, refresh_token_enc: "x", scope: "s", updated_at: new Date(Date.now() + 1000).toISOString() });
    await backdate(id);
    await tick.finalizeSweep({ deps: f.deps, orgId });
    expect(f.calls).toHaveLength(1);
    expect((await read(id)).doc_paused_at).toBeNull();
    expect(await events(id, "resumed")).toHaveLength(1);
  });

  it("abandoned (no heartbeat for 15 min) finalized once; open session closed", async () => {
    const { id, sessionId } = await meeting({ heartbeatAgoSec: 16 * 60 });
    await say(id, sessionId, "hej", 1000);
    const f = fakes();
    await tick.finalizeSweep({ deps: f.deps, orgId });
    await tick.finalizeSweep({ deps: f.deps, orgId });
    const m = await read(id);
    expect(m.status).toBe("abandoned");
    expect(m.ended_at).not.toBeNull();
    expect(f.calls.filter((c) => c.final)).toHaveLength(1);
    expect(f.headers.at(-1)).toMatch(/^Avslutat \d\d:\d\d$/);
    expect(await events(id, "abandoned")).toHaveLength(1);
    const { data: s } = await adminClient().from("el_sessions").select("closed_at").eq("id", sessionId).single();
    expect(s?.closed_at).not.toBeNull();
  });

  it("ending twice is a no-op", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "hej", 1000);
    const f = fakes();
    expect(await tick.endMeeting(id, { deps: f.deps })).toBe("ended");
    expect(await tick.endMeeting(id, { deps: f.deps })).toBe("noop");
    const m = await read(id);
    expect(m.status).toBe("done");
    expect(m.header_rendered).toMatch(/^Avslutat /);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].final).toBe(true);
    expect(await events(id, "ended")).toHaveLength(1);
    const { data: s } = await adminClient().from("el_sessions").select("closed_at").eq("id", sessionId).single();
    expect(s?.closed_at).not.toBeNull();
  });

  it("kill switch or dollar cap → no Claude call (end still finishes, header Avslutat)", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "hej", 1000);
    const f = fakes();
    envOverride.KILL_SWITCH = true;
    await tick.maybeTick(id, f.deps);
    expect(f.renders()).toBe(0);
    expect(await tick.endMeeting(id, { deps: f.deps })).toBe("ended");
    expect(f.calls).toHaveLength(0);
    expect(f.headers.at(-1)).toMatch(/^Avslutat /);
    expect((await read(id)).status).toBe("done");

    envOverride.KILL_SWITCH = false;
    envOverride.GLOBAL_DAILY_USD = 0.000001;
    await adminClient().from("usage_daily").upsert({ org_id: orgId, day: new Date().toISOString().slice(0, 10), usd: 1 });
    const other = await meeting();
    await say(other.id, other.sessionId, "hej", 1000);
    await tick.maybeTick(other.id, f.deps);
    expect(await tick.runTick(other.id, { final: false }, f.deps)).toBe("ok"); // runs, but without Claude
    expect(f.calls).toHaveLength(0);
  });

  it("end route: 401 signed out, 404 for another org's member, starter ends (then noop)", async () => {
    const { id } = await meeting();
    const endCall = (mid: string) =>
      postEnd(new NextRequest(`https://x.test/api/meetings/${mid}/end`, { method: "POST" }), { params: Promise.resolve({ id: mid }) });
    const outsider = await createTestUser("outsider");
    // No stored Google token → the real final tick pauses the Doc (no network) and the end completes.
    await adminClient().from("google_tokens").delete().eq("user_id", starter.id);
    current.db = (await import("@/test/local-supabase")).anonClient();
    expect((await endCall(id)).status).toBe(401);
    current.db = outsider.db;
    expect((await endCall(id)).status).toBe(404);
    current.db = starter.db;
    expect((await endCall("nope")).status).toBe(404);
    const res = await endCall(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "ended" });
    expect((await read(id)).status).toBe("done");
    expect(await (await endCall(id)).json()).toEqual({ result: "noop" });
  });

  it("end with a failing Claude: stays ending (header Avslutat, transcript written); cron retries, after 3 attempts done + alarm", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "hej", 1000);
    const f = fakes({ claudeError: true });
    expect(await tick.endMeeting(id, { deps: f.deps })).toBe("ending");
    let m = await read(id);
    expect(m.status).toBe("ending");
    expect(m.end_attempts).toBe(1);
    expect(m.end_lease_until).toBeNull();
    expect(m.header_rendered).toMatch(/^Avslutat \d\d:\d\d$/);
    expect(f.calls.filter((c) => c.final)).toHaveLength(2);
    expect(f.appended.flat().map((l) => l.text)).toEqual(["hej"]);
    expect(await tick.endMeeting(id, { deps: f.deps })).toBe("noop");

    await tick.finalizeSweep({ deps: f.deps, orgId });
    expect((await read(id)).status).toBe("ending");
    await tick.finalizeSweep({ deps: f.deps, orgId });
    m = await read(id);
    expect(m.status).toBe("done");
    expect(m.end_attempts).toBe(3);
    expect(await events(id, "ended")).toEqual([expect.objectContaining({ detail: expect.objectContaining({ gaveUp: true }) })]);
    expect((await events(id, "alarm")).map((e) => (e.detail as { reason?: string }).reason)).toContain("no_final_pass");
    expect(f.mails).toContain("Simon Says: mötet avslutades utan slutpass");
  });

  it("a tick holding the lease past the end's deadline: stays ending, the cron's next run finishes it", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "hej", 1000);
    const foreign = randomUUID();
    await adminClient()
      .from("meetings")
      .update({ tick_lease_until: new Date(Date.now() + 120_000).toISOString(), tick_lease_id: foreign })
      .eq("id", id);
    const f = fakes();
    expect(await tick.endMeeting(id, { deps: f.deps, deadlineAt: new Date(Date.now() + 30_000) })).toBe("ending");
    expect(f.calls).toHaveLength(0);
    const m = await read(id);
    expect(m.status).toBe("ending");
    expect(m.tick_lease_id).toBe(foreign); // not ours: left alone
    await adminClient().from("meetings").update({ tick_lease_until: null, tick_lease_id: null }).eq("id", id);
    await tick.finalizeSweep({ deps: f.deps, orgId });
    expect((await read(id)).status).toBe("done");
    expect(f.calls.filter((c) => c.final)).toHaveLength(1);
  });

  it("segments arriving during the final pass get a second final pass", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "först", 1000);
    let late = true;
    const f = fakes({
      onUpdate: async (input) => {
        if (input.final && late) {
          late = false;
          await say(id, sessionId, "sist", 2000); // ingest still accepts `ending`
        }
      },
    });
    expect(await tick.endMeeting(id, { deps: f.deps })).toBe("ended");
    expect(f.calls.filter((c) => c.final)).toHaveLength(2);
    expect(f.calls[1].transcriptBlocks.at(-1)).toContain("sist");
    expect(f.appended.flat().map((l) => l.text)).toEqual(["först", "sist"]);
    const { data: segs } = await adminClient().from("segments").select("tick_no").eq("meeting_id", id).is("tick_no", null);
    expect(segs).toEqual([]);
  });

  it("a tick releases only its own lease; not_found for a missing meeting", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "hej", 1000);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const f = fakes({ gate });
    const running = tick.runTick(id, { final: false }, f.deps);
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    // Our lease "expired" and another tick took it.
    const other = randomUUID();
    await adminClient().from("meetings").update({ tick_lease_id: other }).eq("id", id);
    open();
    // B2: the stale tick saves no rows (the newer tick owns them) and reports busy.
    expect(await running).toBe("busy");
    const m = await read(id);
    expect(m.tick_lease_id).toBe(other);
    expect(m.tick_lease_until).not.toBeNull();
    expect(await tick.runTick(randomUUID(), { final: true }, f.deps)).toBe("not_found");
    expect(await tick.finishMeeting(randomUUID(), { deps: f.deps })).toBe("not_found");
  });
});
