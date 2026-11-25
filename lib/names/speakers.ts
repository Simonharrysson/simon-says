import "server-only";
import type { PersonOption, Speaker } from "@/components/live/types";
import { resolveSpeaker, type SpeakerMapRow } from "@/lib/segments/resolve";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isNamed } from "./round";

// The live page's speaker list (Task 11): every label heard so far, per ElevenLabs session,
// resolved through merge aliases, with its name (or none: "Vem är detta?").

export interface HeardLabel {
  el_session_id: string;
  speaker: string;
  first_ms: number;
  talk_ms: number;
}

export type SpeakerRow = SpeakerMapRow & { el_session_id: string; needs_confirm?: boolean };

/** `speaker_1` → "Talare 2"; a later session gets " · del 2" (its labels restart). */
export function speakerLabelText(raw: string, sessionNo: number): string {
  const m = /(\d+)$/.exec(raw);
  const base = m ? `Talare ${Number(m[1]) + 1}` : raw === "unknown" ? "Okänd talare" : raw;
  return sessionNo > 1 ? `${base} · del ${sessionNo}` : base;
}

/** One entry per resolved label, sessions in start order, then by first time heard. */
export function buildSpeakerList(
  heard: HeardLabel[],
  sessions: { id: string; started_at: string }[],
  rows: SpeakerRow[],
): Speaker[] {
  const order = [...sessions].sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id));
  const sessionNo = new Map(order.map((s, i) => [s.id, i + 1]));
  const bySession = new Map<string, SpeakerRow[]>();
  for (const r of rows) bySession.set(r.el_session_id, [...(bySession.get(r.el_session_id) ?? []), r]);
  const out = new Map<string, Speaker & { firstMs: number; no: number }>();
  for (const h of heard) {
    if (h.speaker === "unknown") continue; // undiarized runs: not a person
    const sessionRows = bySession.get(h.el_session_id) ?? [];
    const target = resolveSpeaker(sessionRows, h.speaker).label;
    const key = `${h.el_session_id}::${target}`;
    const prev = out.get(key);
    if (prev) {
      prev.talkSeconds = (prev.talkSeconds ?? 0) + Number(h.talk_ms) / 1000;
      prev.firstMs = Math.min(prev.firstMs, Number(h.first_ms));
      continue;
    }
    const row = sessionRows.find((r) => r.speaker_label === target);
    const no = sessionNo.get(h.el_session_id) ?? 0;
    out.set(key, {
      elSessionId: h.el_session_id,
      speakerLabel: target,
      label: speakerLabelText(target, no),
      displayName: isNamed(row) ? row!.display_name : null,
      needsConfirm: isNamed(row) ? Boolean(row!.needs_confirm) : false,
      talkSeconds: Number(h.talk_ms) / 1000,
      firstMs: Number(h.first_ms),
      no,
    });
  }
  return [...out.values()]
    .sort((a, b) => a.no - b.no || a.firstMs - b.firstMs || a.speakerLabel.localeCompare(b.speakerLabel))
    .map(({ firstMs: _f, no: _n, ...s }) => ({ ...s, talkSeconds: Math.round(s.talkSeconds ?? 0) }));
}

export interface SpeakerView {
  currentElSessionId: string | null;
  /** The current session's name round has run (automatically or via "Klar"). */
  nameRoundDone: boolean;
  speakers: Speaker[];
  /** The org's people, names used in this meeting first. */
  people: PersonOption[];
}

export async function loadSpeakerView(meeting: {
  id: string;
  org_id: string;
  current_el_session_id: string | null;
}): Promise<SpeakerView> {
  const db = supabaseAdmin();
  const [heard, sessions, rows, people] = await Promise.all([
    db.rpc("meeting_speakers", { p_meeting_id: meeting.id }),
    db.from("el_sessions").select("id, started_at, name_round_at").eq("meeting_id", meeting.id),
    db
      .from("speaker_map")
      .select("el_session_id, speaker_label, display_name, person_id, merged_into_label, needs_confirm")
      .eq("meeting_id", meeting.id),
    db.from("people").select("id, name").eq("org_id", meeting.org_id),
  ]);
  for (const [what, res] of Object.entries({ heard, sessions, rows, people })) {
    if (res.error) throw new Error(`speakers: ${what}: ${res.error.message}`);
  }
  const sessionRows = (sessions.data ?? []) as { id: string; started_at: string; name_round_at: string | null }[];
  const mapRows = (rows.data ?? []) as SpeakerRow[];
  const used = new Set(mapRows.filter((r) => isNamed(r)).map((r) => r.person_id));
  const peopleList = ((people.data ?? []) as PersonOption[]).sort(
    (a, b) => Number(used.has(b.id)) - Number(used.has(a.id)) || a.name.localeCompare(b.name, "sv"),
  );
  return {
    currentElSessionId: meeting.current_el_session_id,
    nameRoundDone: Boolean(sessionRows.find((s) => s.id === meeting.current_el_session_id)?.name_round_at),
    speakers: buildSpeakerList((heard.data ?? []) as HeardLabel[], sessionRows, mapRows),
    people: peopleList,
  };
}
