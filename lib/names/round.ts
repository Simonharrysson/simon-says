import "server-only";
import { recordClaudeUsage } from "@/lib/db/claude-usage";
import { logEvent } from "@/lib/db/events";
import { resolveSpeaker, type SpeakerMapRow } from "@/lib/segments/resolve";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { extractNames, NameRoundError, NAME_MAX_CHARS, type ExtractedName, type NameSegment } from "./extract";

// The name round on the server (Task 11). Runs once per ElevenLabs session: from the tick once
// the session has ~2 minutes of speech (or 2 minutes passed since it started), or when the page
// presses "Klar" (forced, also after the automatic one). It only fills labels nobody has named
// yet (resolved through merge aliases), never overwrites a person's choice, adds confidently
// heard new names to the org's people, and records the tokens. It never throws: a failure is
// a `name_round` event and the labels stay raw.

/** Speech span (session time) or wall-clock time after which a session's name round is due. */
export const NAME_ROUND_MS = 120_000;
/** Only the session's first minutes are read, and at most this much text. */
const MAX_SPAN_MS = 5 * 60_000;
const MAX_CHARS = 12_000;
const MAX_SEGMENTS = 400;
/** A forced round ("Klar") does not start while another started less than this ago. */
export const FORCE_GAP_MS = 20_000;

export type ExtractFn = typeof extractNames;

export type NameRoundResult =
  | { status: "ok"; named: ExtractedName[] }
  | { status: "busy" }
  | { status: "failed"; error: string };

const db = () => supabaseAdmin();

function must<T>(what: string, res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(`name round: ${what}: ${res.error.message}`);
  return res.data;
}

const norm = (s: string) => s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

/** A label counts as named once its (resolved) row has a display name other than the label. */
export const isNamed = (row: Pick<SpeakerMapRow, "speaker_label" | "display_name"> | undefined) =>
  Boolean(row && row.display_name !== row.speaker_label);

export interface PendingRound {
  sessionId: string;
  /** Enough speech (or time) for the round; not due → the tick holds back the transcript. */
  due: boolean;
}

/** The meeting's sessions with speech whose name round has not run yet. */
export async function pendingNameRounds(meetingId: string, now: Date): Promise<PendingRound[]> {
  const sessions = must(
    "sessions",
    await db().from("el_sessions").select("id, started_at").eq("meeting_id", meetingId).is("name_round_at", null),
  ) as { id: string; started_at: string }[];
  const out: PendingRound[] = [];
  for (const s of sessions) {
    const edge = async (ascending: boolean) =>
      (
        must(
          "segment span",
          await db().from("segments").select("start_ms").eq("el_session_id", s.id).order("start_ms", { ascending }).limit(1),
        ) as { start_ms: number }[]
      )[0];
    const first = await edge(true);
    if (!first) continue;
    const last = await edge(false);
    const span = Number(last.start_ms) - Number(first.start_ms);
    const age = now.getTime() - new Date(s.started_at).getTime();
    out.push({ sessionId: s.id, due: span >= NAME_ROUND_MS || age >= NAME_ROUND_MS });
  }
  return out;
}

async function event(meetingId: string, detail: Record<string, unknown>): Promise<void> {
  try {
    await logEvent(meetingId, "name_round", detail);
  } catch (e) {
    console.error(`name round ${meetingId}: event: ${(e as Error).message}`);
  }
}

/** The first minutes of one session's speech, capped in length. */
async function roundSegments(sessionId: string): Promise<NameSegment[]> {
  const rows = must(
    "segments",
    await db()
      .from("segments")
      .select("el_session_id, speaker, text, start_ms")
      .eq("el_session_id", sessionId)
      .order("start_ms")
      .order("segment_index")
      .order("run_index")
      .limit(MAX_SEGMENTS),
  ) as NameSegment[];
  const out: NameSegment[] = [];
  let chars = 0;
  const start = rows.length ? Number(rows[0].start_ms) : 0;
  for (const r of rows) {
    const at = Number(r.start_ms);
    chars += r.text.length;
    if (at - start > MAX_SPAN_MS || chars > MAX_CHARS) break;
    out.push({ ...r, start_ms: at });
  }
  return out;
}

/**
 * One name round for `sessionId`. Claimed first (el_sessions.name_round_at): a normal round
 * only if none ran; `force` ("Klar") unless one started < FORCE_GAP_MS ago. `busy`: not run.
 */
export async function runNameRound(
  meeting: { id: string; org_id: string },
  sessionId: string,
  opts: { force?: boolean; timeoutMs?: number; extract?: ExtractFn; now?: Date } = {},
): Promise<NameRoundResult> {
  const now = opts.now ?? new Date();
  const started = Date.now();
  try {
    // Two single-condition updates (each atomic): never run → claim; forced and the last one
    // started long enough ago → claim.
    const claim = () => db().from("el_sessions").update({ name_round_at: now.toISOString() }).eq("id", sessionId).eq("meeting_id", meeting.id);
    let claimed = must("claim", await claim().is("name_round_at", null).select("id")) as unknown[];
    if (!claimed.length && opts.force) {
      const before = new Date(now.getTime() - FORCE_GAP_MS).toISOString();
      claimed = must("claim", await claim().lt("name_round_at", before).select("id")) as unknown[];
    }
    if (!claimed.length) return { status: "busy" };

    const [segments, rowsRes, peopleRes] = await Promise.all([
      roundSegments(sessionId),
      db()
        .from("speaker_map")
        .select("speaker_label, display_name, person_id, merged_into_label")
        .eq("meeting_id", meeting.id)
        .eq("el_session_id", sessionId),
      db().from("people").select("id, name").eq("org_id", meeting.org_id),
    ]);
    const rows = must("speakers", rowsRes) as SpeakerMapRow[];
    const people = must("people", peopleRes) as { id: string; name: string }[];
    const byLabel = new Map(rows.map((r) => [r.speaker_label, r]));

    // Resolved labels nobody has named yet; names already taken in this session.
    const open = new Set<string>();
    for (const raw of new Set(segments.map((s) => s.speaker))) {
      const target = resolveSpeaker(rows, raw).label;
      if (!isNamed(byLabel.get(target))) open.add(target);
    }
    const taken = new Set(rows.filter((r) => isNamed(r) && !r.merged_into_label).map((r) => norm(r.display_name)));
    if (open.size === 0) {
      await event(meeting.id, { sessionId, ok: true, named: 0, skipped: "all named", forced: Boolean(opts.force) });
      return { status: "ok", named: [] };
    }

    let found: ExtractedName[];
    try {
      found = await (opts.extract ?? extractNames)(segments, people.map((p) => p.name), {
        timeoutMs: opts.timeoutMs,
        onUsage: (u) => recordClaudeUsage(meeting.org_id, u),
      });
    } catch (e) {
      const error = e instanceof NameRoundError ? e.message : `${(e as Error).name}: ${(e as Error).message}`.slice(0, 300);
      console.error(`name round ${meeting.id}: ${error}`);
      await event(meeting.id, { sessionId, ok: false, error, ms: Date.now() - started, forced: Boolean(opts.force) });
      return { status: "failed", error };
    }

    // Results per resolved label; a merged pair named differently, or a name another label
    // already has, needs confirming.
    const results = new Map<string, ExtractedName>();
    for (const f of found) {
      if (f.elSessionId !== sessionId) continue;
      const target = resolveSpeaker(rows, f.speakerLabel).label;
      if (!open.has(target)) continue;
      const name = f.name.trim().slice(0, NAME_MAX_CHARS);
      if (!name) continue;
      const prior = results.get(target);
      if (prior) {
        if (norm(prior.name) !== norm(name)) prior.needsConfirm = true;
        continue;
      }
      results.set(target, { elSessionId: sessionId, speakerLabel: target, name, needsConfirm: f.needsConfirm || taken.has(norm(name)) });
    }

    const named: ExtractedName[] = [];
    for (const r of results.values()) {
      let personId = people.find((p) => norm(p.name) === norm(r.name))?.id ?? null;
      if (!personId && !r.needsConfirm) {
        // One retry: a transient gateway error should not cost the person.
        for (let attempt = 0; attempt < 2 && !personId; attempt++) {
          const { data, error } = await db().from("people").insert({ org_id: meeting.org_id, name: r.name }).select("id, name").single();
          if (error) console.error(`name round ${meeting.id}: add person: ${error.message}`);
          else {
            personId = data.id as string;
            people.push(data as { id: string; name: string });
          }
        }
      }
      const values = { display_name: r.name, person_id: personId, needs_confirm: r.needsConfirm };
      const existing = byLabel.get(r.speakerLabel);
      if (existing) {
        // Only while still unnamed: a name someone picked in the meantime wins.
        must(
          "update speaker",
          await db()
            .from("speaker_map")
            .update(values)
            .eq("meeting_id", meeting.id)
            .eq("el_session_id", sessionId)
            .eq("speaker_label", r.speakerLabel)
            .eq("display_name", r.speakerLabel),
        );
      } else {
        must(
          "insert speaker",
          await db()
            .from("speaker_map")
            .upsert(
              { meeting_id: meeting.id, el_session_id: sessionId, speaker_label: r.speakerLabel, ...values },
              { onConflict: "meeting_id,el_session_id,speaker_label", ignoreDuplicates: true },
            ),
        );
      }
      named.push(r);
    }
    await event(meeting.id, {
      sessionId,
      ok: true,
      labels: open.size,
      named: named.length,
      unsure: named.filter((n) => n.needsConfirm).length,
      ms: Date.now() - started,
      forced: Boolean(opts.force),
    });
    return { status: "ok", named };
  } catch (e) {
    const error = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 300);
    console.error(`name round ${meeting.id}: ${error}`);
    await event(meeting.id, { sessionId, ok: false, error });
    return { status: "failed", error };
  }
}
