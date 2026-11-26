import { stockholmDateTime } from "@/lib/calendar/events";
import type { PreparedSuggestion } from "./types";

/**
 * The start screen picks today's prepared agenda (Förbered möte) by itself: only one this
 * starter can edit, and only today's in Swedish time (agenda-candidates also offers the next
 * upcoming one, which stays an offer). Never over a choice the user made (the caller's job).
 */
export function autoPickPrepared(prepared: PreparedSuggestion | null | undefined, now: Date = new Date()): boolean {
  return Boolean(prepared?.accessible && prepared.date === stockholmDateTime(now.toISOString()).date);
}
