// Row types mirroring supabase/migrations/0002_core.sql. Timestamps are ISO strings as
// PostgREST returns them; `numeric` arrives as a number.
// SegmentRow comes with the segments table, after the Task 0 spike.

export type OrgRole = "admin" | "member";
/** 0037: missed = people not at the meeting (default), all, selected = ticked people, off. */
export type SummaryMode = "missed" | "all" | "selected" | "off";
export type SummaryState = "sending" | "sent" | "partial" | "none" | "uncertain" | "no_notes" | "off" | "test" | "before";
export type MeetingStatus = "live" | "ending" | "done" | "abandoned";
export type NoteSection = "decision" | "action" | "now" | "attendees" | "note";
export type NoteKind = "decision" | "task" | "note" | "attendee" | "now";
export type ItemRole = "procedural" | "checkin" | "followup" | "other" | "topic";
export type CheckinWindow = {
  startMs: number | null;
  endMs: number | null;
  closed: boolean;
  failures: number;
  /** Detector calls made so far; absent = 0. */
  calls?: number;
  /** Ticks with new lines the detector schedule skipped since its last call (R-F1); absent = 0. */
  waited?: number;
};

export function kindOfSection(section: NoteSection): NoteKind {
  if (section === "action") return "task";
  if (section === "attendees") return "attendee";
  return section;
}

export function sectionOfKind(kind: NoteKind): NoteSection {
  if (kind === "task") return "action";
  if (kind === "attendee") return "attendees";
  return kind;
}
export type MeetingEventKind =
  | "tick_ok"
  | "tick_failed"
  | "tick_conflict"
  | "doc_paused"
  | "reconnect"
  | "consent"
  | "alarm"
  | "started"
  | "ended"
  | "abandoned"
  | "resumed"
  | "test_started"
  | "paused"
  | "unpaused"
  | "name_round"
  | "final_without_claude"
  | "agenda_anchored"
  | "format_learned"
  | "followup_prefilled"
  | "checkin"
  | "summary";

export interface OrgRow {
  id: string;
  name: string;
  invite_code: string;
  show_on_status: boolean;
  share_transcript: boolean;
  meeting_folder_id?: string | null;
  /** 0030: the folder's name as picked; null when unknown. The förening's text: never logged. */
  meeting_folder_name?: string | null;
  /** 0035: when the logo (storage org-logos/<id>/logo) was last set; null = no logo. */
  logo_updated_at?: string | null;
  /** 0035: the förening's own Styrelsemöte / Årsmöte formats (from the stadgar), used by Förbered möte. */
  styrelse_format_id?: string | null;
  arsmote_format_id?: string | null;
  /** 0037: who gets the summary e-mail after a meeting (lib/summaries). */
  summary_mode?: SummaryMode;
  /** 0044: "Om oss" (plain text, ≤ 600) and links (https, canonical: lib/orgs/profile.ts); null = not set. */
  about?: string | null;
  website_url?: string | null;
  facebook_url?: string | null;
  instagram_url?: string | null;
  /** 0047: "Kräv vem, när och klart när" for tasks (default true). */
  require_task_fields?: boolean;
  created_by: string | null;
  created_at: string;
}

export interface OrgMemberRow {
  org_id: string;
  user_id: string;
  role: OrgRole;
  joined_at: string;
}

export interface PersonRow {
  id: string;
  org_id: string;
  name: string;
  member_user_id: string | null;
  role?: string | null;
  /** 0035: invite e-mail (admins set it; links the person to the member with that address). */
  email?: string | null;
  /** 0035: voice consent recorded for the coming voice feature (when, by whom). */
  voice_consent_at?: string | null;
  voice_consent_by?: string | null;
  /** 0037: ticked for summary_mode 'selected' (only through set_summary_settings). */
  summary_selected?: boolean;
  /** 0037: set when the linked member was removed (or deleted their account); no e-mail by the old address. */
  summary_removed_at?: string | null;
}

export interface MeetingRow {
  id: string;
  org_id: string;
  started_by: string | null;
  doc_id: string;
  notes_tab_id: string;
  transcript_tab_id: string | null;
  header_range: string | null;
  /** The header line the service last wrote (migration 0006); null = unknown. */
  header_rendered: string | null;
  section_ranges: Record<string, unknown>;
  status: MeetingStatus;
  consent_confirmed_at: string | null;
  started_at: string;
  ended_at: string | null;
  last_heartbeat_at: string | null;
  last_tick_at: string | null;
  last_tick_ok_at: string | null;
  failed_ticks: number;
  tick_lease_until: string | null;
  doc_paused_at: string | null;
  current_el_session_id: string | null;
  /** The notes id counter (`n<k>`) for the next new item (migration 0010, Ruling 19). */
  notes_next_id?: string | null;
  /** Highest transcript tick_no already sent to Claude (migration 0010). */
  notes_sent_tick?: number;
  /** Owner of the current tick lease (migration 0010). */
  tick_lease_id?: string | null;
  /** Status the meeting gets once its final pass went through (Ruling 27). */
  end_status?: "done" | "abandoned" | null;
  /** End attempts so far (the cron retries up to 3). */
  end_attempts?: number;
  /** A running end attempt's lock. */
  end_lease_until?: string | null;
  agenda_doc?: boolean;
  format_profile_id?: string | null;
  layout?: "v1" | "format";
  is_test?: boolean;
  agenda_roles?: Record<string, ItemRole>;
  checkin_window?: CheckinWindow | null;
  /** `ag-<n>` → the agenda item's label, safe labels only (migration 0028, org dashboard). */
  agenda_labels?: Record<string, string>;
  /** 0037: null = summary not handled yet; else why it is done. */
  summary_state?: SummaryState | null;
  summary_at?: string | null;
  /** 0047: the Avsluta dialog's answers, applied by the final pass (lib/notes/tasks.ts). */
  task_answers?: unknown;
}

/** Every ElevenLabs session the server minted. Usage: see `orgMonthSeconds`. */
export interface ElSessionRow {
  id: string;
  meeting_id: string;
  started_at: string;
  max_seconds: number;
  closed_at: string | null;
}

export interface MeetingEventRow {
  id: number;
  meeting_id: string;
  at: string;
  kind: MeetingEventKind;
  detail: Record<string, unknown>;
}

export interface SpeakerMapRow {
  meeting_id: string;
  el_session_id: string;
  speaker_label: string;
  person_id: string | null;
  display_name: string;
  needs_confirm: boolean;
}

export interface NoteItemRow {
  meeting_id: string;
  id: string;
  section: NoteSection;
  text: string;
  owner: string | null;
  due: string | null;
  locked: boolean;
  deleted_by_human: boolean;
  last_rendered_text: string | null;
  range_name: string | null;
  position: number;
  kind?: NoteKind | null;
  anchor?: string | null;
  done?: boolean;
  owner_person_id?: string | null;
  carried_from_meeting?: string | null;
  carried_from_id?: string | null;
  copy_of?: string | null;
  /** 0047: "Klart när": the measurable result that makes the task done; null = not said. */
  done_when?: string | null;
  /** 0047: `due` as a date (YYYY-MM-DD) when it names one; carried tasks keep their source's. */
  due_date?: string | null;
}

export interface UsageDailyRow {
  org_id: string;
  day: string;
  seconds: number;
  claude_input_tokens: number;
  claude_output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  usd: number;
}
