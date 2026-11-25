import type { ItemRole } from "@/lib/db/types";
import type { FormatProfile } from "./schema";

// A format profile as the blocks of a new Doc (spec G8 / "Builder check — answers" 5): the
// fallback Doc when there is no agenda Doc, the Testmöte Doc (A13) and the Phase B preview. Pure;
// lib/docs/skeleton.ts turns the blocks into Docs requests.

export type SkeletonBlock =
  | { type: "title" | "heading" | "item" | "subitem" | "para"; text: string }
  | { type: "table"; rows: [string, string][] };

/** The topic item every skeleton carries (spec answer 5): collects topics that fit no fixed item. */
export const OTHER_TOPICS = "Övriga punkter";
/** The blank a signature line ends with. */
export const SIGNATURE_BLANK = "____________________";

export interface SkeletonItem {
  label: string;
  sub?: string[];
}

/** Default items in Doc order: fixed items (not "last"), "Övriga punkter", then the "last" ones. */
function defaultItems(profile: FormatProfile): { label: string; role: ItemRole }[] {
  const fixed = profile.fixedAgendaItems;
  return [
    ...fixed.filter((i) => i.position !== "last").map((i) => ({ label: i.label, role: i.role })),
    { label: OTHER_TOPICS, role: "topic" as const },
    ...fixed.filter((i) => i.position === "last").map((i) => ({ label: i.label, role: i.role })),
  ];
}

export function skeletonBlocks(
  profile: FormatProfile,
  opts: { items?: SkeletonItem[]; filled?: Record<string, string> } = {},
): SkeletonBlock[] {
  const blocks: SkeletonBlock[] = [{ type: "title", text: profile.title }];
  if (profile.infoTable?.length) {
    blocks.push({ type: "table", rows: profile.infoTable.map((f) => [f, opts.filled?.[f] ?? ""] as [string, string]) });
  }
  // Always an agenda heading: the scan finds heading items only below one.
  blocks.push({ type: "heading", text: profile.agendaHeading ?? "Agenda" });
  const items: SkeletonItem[] = opts.items ?? defaultItems(profile).map((i) => ({ label: i.label }));
  items.forEach((item, i) => {
    const text = profile.numbering === "paragraph" ? `§${i + 1} ${item.label}` : item.label;
    blocks.push({ type: "item", text });
    for (const sub of item.sub ?? []) blocks.push({ type: "subitem", text: sub });
  });
  if (profile.tasksSection) blocks.push({ type: "heading", text: profile.tasksSection.label });
  if (profile.notesSection) blocks.push({ type: "heading", text: profile.notesSection.label });
  for (const role of profile.signatures ?? []) blocks.push({ type: "para", text: `${role}: ${SIGNATURE_BLANK}` });
  return blocks;
}

/** Roles of the default skeleton's items by anchor key (`ag-<n>` in skeleton order). */
export function rolesFromSkeleton(profile: FormatProfile): Record<string, ItemRole> {
  return Object.fromEntries(defaultItems(profile).map((item, i) => [`ag-${i + 1}`, item.role]));
}
