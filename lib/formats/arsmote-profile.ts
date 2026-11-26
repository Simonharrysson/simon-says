import { labelsMatch } from "@/lib/agenda/scan";
import type { FixedItem, FormatProfile } from "./schema";
import { parseProfile } from "./schema";
import { ARSMOTE } from "./standard";

// The förening's own Årsmöte format from the agenda its stadgar list (onboarding step 4). Pure,
// so the browser's editor shows the same result the server stores.

export const ARSMOTE_MAX_ITEMS = 18;

/**
 * ARSMOTE with the stadgar's items as its agenda, in their order. A standard item's label keeps
 * its key and role (procedural items stay procedural); "Övriga frågor" and "Mötets avslutande"
 * stay last (added when the stadgar don't list them). No items, or an invalid result → ARSMOTE.
 */
export function arsmoteProfile(items: string[]): FormatProfile {
  const clean = items.map((s) => s.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, 80).trim()).filter(Boolean);
  if (clean.length === 0) return ARSMOTE;
  const lastStd = ARSMOTE.fixedAgendaItems.filter((i) => i.position === "last");
  const used = new Set<string>();
  const fixed: FixedItem[] = [];
  let n = 0;
  for (const label of clean.slice(0, ARSMOTE_MAX_ITEMS)) {
    const std = ARSMOTE.fixedAgendaItems.find((i) => !used.has(i.key) && labelsMatch(i.label, label));
    if (fixed.some((f) => f.label.toLowerCase() === label.toLowerCase())) continue;
    if (std) {
      used.add(std.key);
      fixed.push({ key: std.key, label, role: std.role, ...(std.position ? { position: std.position } : {}) });
    } else {
      fixed.push({ key: `s${++n}`, label, role: "other" });
    }
  }
  // Items the stadgar placed after "Övriga frågor" still sort with the "last" ones in the Doc;
  // the standard closing items are added when missing.
  for (const std of lastStd) if (!used.has(std.key)) fixed.push(std);
  const profile = parseProfile({ ...ARSMOTE, fixedAgendaItems: fixed });
  return profile ?? ARSMOTE;
}
