export interface SpeakerMapRow {
  speaker_label: string;
  display_name: string;
  person_id?: string | null;
  merged_into_label?: string | null;
}

export interface ResolvedSpeaker {
  /** The label the raw one finally means (follows merges A -> B -> C). */
  label: string;
  /** The final label's display name (its speaker_map row), else the final label itself. */
  displayName: string;
  personId: string | null;
}

/**
 * Resolve a raw speaker label of ONE ElevenLabs session through merge aliases. Resolved at
 * read time, so a merge recorded before the target was identified picks up the target's name
 * later. `rows` are that session's speaker_map rows.
 */
export function resolveSpeaker(rows: SpeakerMapRow[], rawLabel: string): ResolvedSpeaker {
  const byLabel = new Map(rows.map((r) => [r.speaker_label, r]));
  let label = rawLabel;
  for (let hops = 0; hops < 50; hops++) {
    const next = byLabel.get(label)?.merged_into_label;
    if (!next || next === label) break;
    label = next;
  }
  const row = byLabel.get(label);
  return { label, displayName: row?.display_name ?? label, personId: row?.person_id ?? null };
}
