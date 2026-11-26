import type { ItemRole } from "@/lib/db/types";

// Förbered möte: the types and names the UI shares with the server (no server or Doc code here,
// so client components stay small).

/** The meeting types the ordförande chooses between; Veckomöte "almost always". */
export type MeetingType = "veckomote" | "styrelsemote" | "arsmote";

export const MEETING_TYPES: { type: MeetingType; name: string; hint: string }[] = [
  { type: "veckomote", name: "Veckomöte", hint: "Det vanliga mötet. Följer upp förra veckans uppgifter." },
  { type: "styrelsemote", name: "Styrelsemöte", hint: "Med paragrafer, justerare och underskrifter." },
  { type: "arsmote", name: "Årsmöte", hint: "Föreningens årsmöte med standarddagordningen." },
];

export const isMeetingType = (v: unknown): v is MeetingType => MEETING_TYPES.some((t) => t.type === v);
export const meetingTypeName = (t: MeetingType) => MEETING_TYPES.find((x) => x.type === t)!.name;

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
