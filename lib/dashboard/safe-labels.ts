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
