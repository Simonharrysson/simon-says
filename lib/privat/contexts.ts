// Contexts of a Privat space (0045): what a recording is about ("TDDE15", "Kundmöten",
// "Övrigt"). Pure rules here; the database calls are in contexts-db.ts.

export interface ContextRow {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

export const CONTEXT_NAME_MAX = 80;
/** Offered when the space has no context yet. */
export const DEFAULT_CONTEXT_NAME = "Övrigt";

/** A typed name made safe: one line, spaces collapsed, at most 80 characters; null when empty. */
export function cleanContextName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const name = input.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  if (!name) return null;
  return name.length > CONTEXT_NAME_MAX ? name.slice(0, CONTEXT_NAME_MAX).trimEnd() : name;
}

const key = (name: string) => name.normalize("NFC").toLocaleLowerCase("sv-SE");

/** An existing context with the same name (case-insensitive), so "tdde15" reuses "TDDE15". */
export function findByName<T extends Pick<ContextRow, "name">>(contexts: T[], name: string): T | null {
  const k = key(name);
  return contexts.find((c) => key(c.name) === k) ?? null;
}

/** Most recently used first, then newest; never-used last. */
export function sortContexts<T extends ContextRow>(contexts: T[]): T[] {
  return [...contexts].sort((a, b) => {
    const au = a.last_used_at ? Date.parse(a.last_used_at) : -Infinity;
    const bu = b.last_used_at ? Date.parse(b.last_used_at) : -Infinity;
    if (au !== bu) return bu - au;
    return Date.parse(b.created_at) - Date.parse(a.created_at);
  });
}

/** The context the picker suggests: the last one used, else the newest; null for an empty space. */
export function suggestedContext<T extends ContextRow>(contexts: T[]): T | null {
  return sortContexts(contexts)[0] ?? null;
}

/**
 * The context a start uses: the requested one when it is in this space, else none (the request is
 * refused: a stale page must not record into the wrong context silently).
 */
export function resolveContext<T extends Pick<ContextRow, "id">>(contexts: T[], requested: unknown): T | null {
  if (typeof requested !== "string") return null;
  return contexts.find((c) => c.id === requested) ?? null;
}
