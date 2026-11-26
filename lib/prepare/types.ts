import type { ItemRole } from "@/lib/db/types";

// Förbered möte: the types and names the UI shares with the server (no server or Doc code here,
// so client components stay small).

/**
 * A prepared agenda's meeting type. "styrelsemote" is no longer offered (todo #15: a förening has
 * its ordinary meetings and its årsmöte; the stadgar are for the årsmöte), but agendas prepared as
 * one before stay readable, so the type remains for stored rows.
 */
export type MeetingType = "veckomote" | "styrelsemote" | "arsmote";

/** The meeting types the ordförande chooses between; Veckomöte "almost always". */
export const MEETING_TYPES: { type: MeetingType; name: string; hint: string }[] = [
  { type: "veckomote", name: "Veckomöte", hint: "Det vanliga mötet, i föreningens format. Följer upp förra veckans uppgifter." },
  { type: "arsmote", name: "Årsmöte", hint: "Föreningens årsmöte, med dagordningen från era stadgar eller standarden." },
];

const NAMES: Record<MeetingType, string> = { veckomote: "Veckomöte", styrelsemote: "Styrelsemöte", arsmote: "Årsmöte" };

/** Any stored type (an agenda prepared as a Styrelsemöte before todo #15 included). */
/** A draft item that is one of the förening's goals ("Mål: …"). */
export const isGoalItem = (i: Pick<DraftItem, "id">) => i.id.startsWith("goal:");

export const isMeetingType = (v: unknown): v is MeetingType => typeof v === "string" && Object.hasOwn(NAMES, v);
/** A type that can be chosen for a new agenda. */
export const isOfferedType = (v: unknown): v is MeetingType => MEETING_TYPES.some((t) => t.type === v);
export const meetingTypeName = (t: MeetingType) => NAMES[t] ?? NAMES.veckomote;

/** One open task under "Från förra veckan". `source`: `<meeting id>:<item id>` of the task carried. */
export interface DraftTask {
  source: string;
  /** The line as it will stand in the Doc ("Kassör: Boka Kårallen (fredag)."). */
  line: string;
  on: boolean;
}

export type DraftSource = "standing" | "suggested" | "added";

export interface DraftItem {
  /** `std:<fixed key>`, `topic:<normalised label>` or `add:<random>`. */
  id: string;
  label: string;
  role: ItemRole;
  source: DraftSource;
  /** On the agenda (suggestions start unticked). */
  on: boolean;
  /** A standing item the format keeps at the end (Övrigt, Mötets avslutande). */
  last?: boolean;
  /** Suggestions: how many earlier meetings had the topic. */
  meetings?: number;
  /**
   * A goal suggestion ("Mål att ta upp", todo #12; id `goal:…`): why Simon Says brings it up
   * ("Inget nytt sedan 12 okt"). Shown in the UI only, never in the Doc; always the server's.
   */
  reason?: string;
  /** The follow-up item: the open tasks it will list. */
  tasks?: DraftTask[];
  /** The follow-up item: where its tasks come from (shown under it). */
  origin?: FollowupOrigin;
}

/**
 * Where "Från förra veckan" takes its open tasks from: the previous real Simon Says meeting
 * (`meeting`), an imported protocol newer than that (`import`, within 60 days of the prepared
 * date), nothing because that protocol is older (`too_old`), or no earlier meeting at all (`none`;
 * Testmöten never count). `date`: the source meeting's local date (YYYY-MM-DD).
 */
export type FollowupOrigin = { kind: "meeting" | "import" | "too_old"; date: string } | { kind: "none" };


/** The start screen's prepared-agenda suggestion (agenda-candidates `prepared`). */
export interface PreparedSuggestion {
  docId: string;
  /** The Doc's file name (the förening's text). */
  name: string;
  date: string;
  time: string | null;
  kind: MeetingType;
  /** This starter's own Google grant can edit it (drive.file: the preparer's can). */
  accessible: boolean;
}
