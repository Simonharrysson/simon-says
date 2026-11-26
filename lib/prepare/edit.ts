import type { DraftItem } from "./types";

// Förbered möte, client side (pure, no React): what "Skapa dagordning" sends. The UI's own edit
// helpers (move, remove, add back) live with the view; these two decide what reaches the server.

/** Put an item (back) on the agenda, before the items the format keeps last. */
export function addBack(items: DraftItem[], id: string): DraftItem[] {
  const it = items.find((i) => i.id === id);
  if (!it) return items;
  const rest = items.filter((i) => i.id !== id);
  const at = it.last ? rest.length : rest.findIndex((i) => i.last && i.on);
  const pos = at < 0 ? rest.length : at;
  return [...rest.slice(0, pos), { ...it, on: true }, ...rest.slice(pos)];
}

/** A new item the ordförande knows about, before the items the format keeps last. */
export function addItem(items: DraftItem[], label: string, id: string): DraftItem[] {
  const clean = label.replace(/\s+/g, " ").trim();
  if (!clean) return items;
  return addBack([...items, { id, label: clean, role: "topic", source: "added", on: false }], id);
}

/**
 * The items to save: a point still typed in "Lägg till punkt" (never pressed "Lägg till") is on
 * the agenda too. Typing a point and pressing "Skapa dagordning" must never lose it.
 */
export function withPending(items: DraftItem[], pending: string, id: string): DraftItem[] {
  return addItem(items, pending, id);
}

/** The request body's items: empty added points left out, an emptied label never sent empty. */
export function bodyItems(items: DraftItem[]) {
  return items
    .filter((i) => i.source !== "added" || i.label.trim())
    .map((i) => ({
      id: i.id,
      label: i.label.trim() || "Punkt",
      source: i.source,
      on: i.on && i.label.trim() !== "",
      ...(i.tasks ? { tasks: i.tasks.map((t) => ({ source: t.source, on: t.on })) } : {}),
    }));
}
