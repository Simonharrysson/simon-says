import { EMAIL_CATEGORIES, type EmailPrefs } from "@/lib/email/categories";

/**
 * Konto → Mejl's summary while closed: how many of the switches are on ("5 av 6 på").
 * `orgBriefs`: "Även inför föreningsmöten" when it is offered (it counts as a switch of its own,
 * on only while "Inför möten" is on too). "Stäng av alla mejl" makes it 0.
 */
export function mailSummary(prefs: EmailPrefs, orgBriefs?: boolean): { on: number; total: number } {
  const offered = orgBriefs !== undefined;
  const total = EMAIL_CATEGORIES.length + (offered ? 1 : 0);
  if (prefs.allOff) return { on: 0, total };
  const categories = EMAIL_CATEGORIES.filter((c) => !prefs.off.includes(c)).length;
  const extra = offered && orgBriefs && !prefs.off.includes("meeting_brief") ? 1 : 0;
  return { on: categories + extra, total };
}
