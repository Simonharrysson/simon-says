import type { ItemRole } from "@/lib/db/types";
import { normLabel } from "./scan";

// The words that mark an agenda label as a fixed item (check-in, follow-up, formalities, other).
// Pure: the fuzzy role match (./roles) and the Översikt's imported protocols, which carry no roles.

const SYNONYMS: Record<Exclude<ItemRole, "topic">, string[]> = {
  checkin: ["må-runda", "måsrunda", "incheckning", "check-in", "hur mår"],
  followup: ["från förra", "förra veckan", "föregående protokoll", "uppföljning"],
  procedural: ["godkänn", "dagordning", "öppnande", "val av", "justerare", "avslutande"],
  other: ["övrigt", "övriga frågor"],
};

/** The fixed role a label's words point to, or null (a topic). */
export function synonymRole(label: string): Exclude<ItemRole, "topic"> | null {
  const n = normLabel(label);
  for (const [r, words] of Object.entries(SYNONYMS) as [Exclude<ItemRole, "topic">, string[]][]) {
    if (words.some((w) => n.includes(w))) return r;
  }
  return null;
}
