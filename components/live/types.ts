// Plain data shapes for the live meeting components. Task 7/11/12 map server and
// LiveStream state onto these; the components never fetch anything themselves.

/** Where the meeting is in its life, from the page's point of view. */
export type LivePhase =
  | "consent" // before Start: consent checkbox + Start
  | "starting" // Start pressed: asking for the mic, minting a token, creating the Doc
  | "name-round" // live, the name round is on
  | "live"
  | "paused"
  | "ending" // Stopp pressed: final pass running
  | "ended"
  | "resume" // an unfinished meeting was found: offer "Fortsätt mötet"
  | "error"; // could not get going again (e.g. 3 failed token requests)

/** Speaker labels are only unique within one ElevenLabs session. */
export interface SpeakerKey {
  elSessionId: string;
  speakerLabel: string;
}

export interface Speaker extends SpeakerKey {
  /** "Talare 2" style label as shown before a name is known. */
  label: string;
  /** Assigned name, or null when nobody has said who this is yet. */
  displayName: string | null;
  /** The name is a guess (name round clash, low confidence): show "Anna?" with confirm. */
  needsConfirm: boolean;
  /** Seconds this speaker has talked in the meeting, for ordering and the meter. */
  talkSeconds?: number;
}

export interface PersonOption {
  id: string;
  name: string;
}

/** What the user picked for a speaker: an existing person or a new name. */
export type SpeakerChoice = { personId: string; displayName: string } | { personId: null; displayName: string };

export type ConnectionState = "ok" | "reconnecting" | "offline";

export const speakerKeyString = (k: SpeakerKey) => `${k.elSessionId}::${k.speakerLabel}`;
