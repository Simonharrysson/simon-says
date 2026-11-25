// What may be stored as a speaker's name (Task 11 review I4). A name ends up in speaker_map,
// the org's people, the Doc transcript and the notes prompt, and it is heard from a room (or
// typed), so it is kept to what a name looks like: letters, marks, apostrophe, space, dot and
// hyphen; at most 60 characters and 4 words. Anything else is dropped (the label stays).

const NAME = /^[\p{L}\p{M}' .-]{1,60}$/u;
export const NAME_MAX_WORDS = 4;

/** The cleaned name (NFC, single spaces, trimmed), or null when it doesn't look like a name. */
export function validName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (/[\n\r:]/.test(raw)) return null;
  const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!name || !NAME.test(name) || !/\p{L}/u.test(name)) return null;
  if (name.split(" ").length > NAME_MAX_WORDS) return null;
  return name;
}

/** A full name: at least two words. */
export const isFullName = (name: string) => name.trim().split(/\s+/).length >= 2;
