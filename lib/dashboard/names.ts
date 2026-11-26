// People's names out of stored text (org dashboard): the goals proposal's input and the agenda
// labels Simon Says stores. Pure.

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces each person's full name, then each name part (≥ 2 letters, also genitive), with "en person". */
export function scrubNames(text: string, names: string[]): string {
  const parts = [...new Set(names.flatMap((n) => [n.trim(), ...n.trim().split(/\s+/)]).filter((p) => p.length >= 2))].sort(
    (a, b) => b.length - a.length,
  );
  let out = text;
  for (const p of parts) out = out.replace(new RegExp(`(?<![\\p{L}])${escape(p)}s?(?![\\p{L}])`, "giu"), "en person");
  return out;
}

