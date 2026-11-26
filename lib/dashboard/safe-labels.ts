import { scrubNames } from "./names";

/**
 * A word after the first that starts with a capital and goes on in lower case ("Rapport från
 * Elin", "Möte med Kårstyrelsen"): in a Swedish agenda label that is a name or a proper noun, so
 * the label is not stored. All-caps abbreviations after the first word ("Frågor till IT") are fine.
 */
export const hasInnerName = (label: string) =>
  label
    .split(/\s+/)
    .slice(1)
    .some((w) => /^\p{Lu}\p{Ll}/u.test(w));

/**
 * An agenda label Simon Says may store for the dashboard: passes `safe` (the format-learning
 * filter: ≤ 8 words, no digits, no first name, not "Två Versaler"), holds no full name or surname
 * of the org's people (`scrubNames` leaves it unchanged) and has no capitalised word after the first.
 */
export function storableLabel(label: string, names: string[], safe: (label: string) => boolean): boolean {
  return safe(label) && scrubNames(label, names) === label && !hasInnerName(label);
}

/** Agenda keys → labels worth storing: `ag-<n>` keys only, collapsed, passing `safe`, ≤ 120 chars. */
export function safeAgendaLabels(items: { key: string; label: string }[], safe: (label: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, label } of items) {
    if (!/^ag-\d+$/.test(key)) continue;
    const clean = label.normalize("NFC").replace(/\s+/g, " ").trim();
    if (!clean || clean.length > 120 || !safe(clean)) continue;
    out[key] = clean;
  }
  return out;
}
