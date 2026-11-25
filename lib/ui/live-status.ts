// One status for the live page. Badge, mic ring, partial text, Doc card and banners are all
// derived from it, so the screen can never say two different things at once.

export type LivePhaseForStatus =
  | "consent"
  | "starting"
  | "name-round"
  | "live"
  | "paused"
  | "ending"
  | "ended"
  | "resume"
  | "error";

export interface LiveStatusInput {
  phase: LivePhaseForStatus;
  connection: "ok" | "reconnecting" | "offline";
  /** The first connection of this page (not a reconnect): "Ansluter…", no "Anslutningen bröts". */
  firstConnect?: boolean;
  docPaused?: boolean;
  staleMinutes?: number | null;
  minutesLeft?: number | null;
}

/** What the header headline says. `live` pulses red; `alert` is static red ("needs you"). */
export type StatusTone = "live" | "paused" | "waiting" | "alert";

/** At most one is shown; the rest sit behind "+N till". Ordered most urgent first. */
export type LiveBannerKind = "error" | "doc" | "time" | "connection";

/** What the partial strip shows: live words, the last words in grey, or a fixed line. */
export type PartialMode = "live" | "last-heard" | "paused" | "silent";

/** What the Doc card says about the notes. */
export type DocHealth = "ok" | "stale" | "paused";

export interface LiveStatus {
  kind: "live" | "paused" | "reconnecting" | "error" | "ending";
  tone: StatusTone;
  label: string;
  /** Short second part of the headline, e.g. "inget ljud skickas". */
  detail: string | null;
  /** The listening ring around the mic: only while sound really goes out. */
  listening: boolean;
  partial: PartialMode;
  /** Paus makes sense only while something is running. */
  canPause: boolean;
  banners: LiveBannerKind[];
  doc: DocHealth;
}

export function liveStatus(input: LiveStatusInput): LiveStatus {
  const { phase, connection, firstConnect = false, docPaused = false, staleMinutes = null, minutesLeft = null } = input;
  const connected = connection === "ok";

  const banners: LiveBannerKind[] = [];
  if (phase === "error") banners.push("error");
  if (docPaused && phase !== "ending") banners.push("doc");
  if (minutesLeft != null && phase !== "error" && phase !== "ending") banners.push("time");
  // No "audio is held" banner while paused (nothing is sent, nothing held) or on the first connect.
  if (!connected && !firstConnect && phase !== "error" && phase !== "ending" && phase !== "paused") banners.push("connection");

  const doc: DocHealth = docPaused ? "paused" : staleMinutes != null ? "stale" : "ok";
  const base = { banners, doc };

  if (phase === "error") {
    return { ...base, kind: "error", tone: "alert", label: "Stannat", detail: "behöver dig", listening: false, partial: "silent", canPause: false };
  }
  if (phase === "ending") {
    return { ...base, kind: "ending", tone: "waiting", label: "Avslutar…", detail: null, listening: false, partial: "silent", canPause: false };
  }
  if (phase === "paused") {
    return { ...base, kind: "paused", tone: "paused", label: "Pausat", detail: "inget ljud skickas", listening: false, partial: "paused", canPause: true };
  }
  if (!connected) {
    return {
      ...base,
      kind: "reconnecting",
      tone: "waiting",
      label: firstConnect ? "Ansluter…" : "Ansluter igen…",
      detail: null,
      listening: false,
      partial: "last-heard",
      canPause: true,
    };
  }
  return { ...base, kind: "live", tone: "live", label: "Transkriberar", detail: null, listening: true, partial: "live", canPause: true };
}
