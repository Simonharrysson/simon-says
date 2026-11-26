import { defaultLocale, type Locale } from "@/lib/i18n/config";
import { translator } from "@/lib/i18n/translator";
import type { ItemRole } from "@/lib/db/types";
import { FormatProfileSchema, type FixedItem, type FormatProfile } from "./schema";
import { VECKOMOTE } from "./standard";

// The format editor's state (Task B2): a learned proposal, or a Styrelseprotokoll with items from
// the stadgar (C1), as plain fields the admin edits before approving. Pure, client-safe.

export interface EditorItem {
  label: string;
  role: ItemRole;
  /** Always at the end of the agenda (e.g. "Övrigt", "Mötets avslutande"). */
  last: boolean;
  /** The key the item came with; new items get one from their label. */
  key?: string;
}

export interface EditorState {
  title: string;
  /** Info table fields; none = no table. */
  infoTable: string[];
  /** "" = no agenda heading. */
  agendaHeading: string;
  items: EditorItem[];
  numbering: FormatProfile["numbering"];
  tasks: { on: boolean; label: string; groupBy: "role" | "person" };
  notes: { on: boolean; label: string };
  /** Signature lines; none = no signatures. */
  signatures: string[];
  /** Agenda items the stadgar require (C1). */
  requiredItems: string[];
  /** Hide the Må-runda from the notes (opt-in, experimental; default off). */
  hideCheckin: boolean;
  /** Optional name of the format ("" = default name). */
  name: string;
}

// Role names shown in the editor are UI copy: formatEditor.roles.* in lib/i18n/messages.

const MAX = 80;
const MAX_ITEMS = 20;
const MAX_FIELDS = 8;
const MAX_REQUIRED = 15;

const clean = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();
const list = (xs: string[]) => xs.map(clean).filter(Boolean);

export function profileToEditor(p: FormatProfile): EditorState {
  return {
    title: p.title,
    infoTable: [...(p.infoTable ?? [])],
    agendaHeading: p.agendaHeading ?? "",
    items: p.fixedAgendaItems.map((i) => ({ label: i.label, role: i.role, last: i.position === "last", key: i.key })),
    numbering: p.numbering,
    tasks: p.tasksSection
      ? { on: true, label: p.tasksSection.label, groupBy: p.tasksSection.groupBy }
      : { on: false, label: "Att göra", groupBy: "role" },
    notes: p.notesSection ? { on: true, label: p.notesSection.label } : { on: false, label: "Anteckningar" },
    signatures: [...(p.signatures ?? [])],
    requiredItems: [...p.requiredItems],
    hideCheckin: p.hideCheckin === true,
    name: p.name ?? "",
  };
}

/** A key from a label: lowercase ASCII, å/ä → a, ö → o, dashes, at most 40 characters. */
export function keyFromLabel(label: string): string {
  const base = clean(label)
    .toLowerCase()
    .replace(/[åä]/g, "a")
    .replace(/ö/g, "o")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/, "");
  return base || "punkt";
}

/**
 * The profile the editor describes (kind "learned"; the caller sets another kind when it
 * approves a standard one), or the Swedish errors to show. Keys an item came with are kept;
 * new or duplicate ones are made from the label. Empty rows in the lists are dropped.
 */
export function editorToProfile(s: EditorState, locale: Locale = defaultLocale): { ok: true; profile: FormatProfile } | { ok: false; errors: string[] } {
  const t = translator(locale);
  const e = (key: Parameters<typeof t>[0], values?: Record<string, number>) => t(key, values as never);
  const errors: string[] = [];
  const title = clean(s.title);
  if (!title) errors.push(e("formatEditor.errors.titleEmpty"));
  else if (title.length > MAX) errors.push(e("formatEditor.errors.titleLong", { max: MAX }));

  const name = clean(s.name ?? "");
  if (name.length > 60) errors.push(e("formatEditor.errors.nameLong", { max: 60 }));

  const infoTable = list(s.infoTable);
  if (infoTable.length > MAX_FIELDS) errors.push(e("formatEditor.errors.tableFields", { max: MAX_FIELDS }));
  const signatures = list(s.signatures);
  if (signatures.length > MAX_FIELDS) errors.push(e("formatEditor.errors.signatures", { max: MAX_FIELDS }));
  const requiredItems = list(s.requiredItems);
  if (requiredItems.length > MAX_REQUIRED) errors.push(e("formatEditor.errors.required", { max: MAX_REQUIRED }));
  if ([...infoTable, ...signatures, ...requiredItems].some((x) => x.length > MAX)) {
    errors.push(e("formatEditor.errors.fieldLong", { max: MAX }));
  }

  const agendaHeading = clean(s.agendaHeading);
  if (agendaHeading.length > MAX) errors.push(e("formatEditor.errors.agendaLong", { max: MAX }));

  if (s.items.some((i) => !clean(i.label))) errors.push(e("formatEditor.errors.itemEmpty"));
  if (s.items.some((i) => clean(i.label).length > MAX)) errors.push(e("formatEditor.errors.itemLong", { max: MAX }));
  if (s.items.length > MAX_ITEMS) errors.push(e("formatEditor.errors.items", { max: MAX_ITEMS }));
  if (s.items.filter((i) => i.role === "checkin").length > 1) errors.push(e("formatEditor.errors.oneCheckin"));
  if (s.items.filter((i) => i.role === "followup").length > 1) errors.push(e("formatEditor.errors.oneFollowup"));

  const tasksLabel = clean(s.tasks.label);
  if (s.tasks.on && !tasksLabel) errors.push(e("formatEditor.errors.tasksEmpty"));
  const notesLabel = clean(s.notes.label);
  if (s.notes.on && !notesLabel) errors.push(e("formatEditor.errors.notesEmpty"));
  if ((s.tasks.on && tasksLabel.length > MAX) || (s.notes.on && notesLabel.length > MAX)) {
    errors.push(e("formatEditor.errors.headingsLong", { max: MAX }));
  }
  if (errors.length) return { ok: false, errors };

  const used = new Set<string>();
  const fixedAgendaItems: FixedItem[] = s.items.map((i) => {
    let key = i.key && /^[a-z0-9-]{1,40}$/.test(i.key) && !used.has(i.key) ? i.key : keyFromLabel(i.label);
    for (let n = 2; used.has(key); n++) key = `${keyFromLabel(i.label)}-${n}`;
    used.add(key);
    return { key, label: clean(i.label), role: i.role, ...(i.last ? { position: "last" as const } : {}) };
  });

  const parsed = FormatProfileSchema.safeParse({
    kind: "learned",
    title,
    infoTable: infoTable.length ? infoTable : null,
    agendaHeading: agendaHeading || null,
    fixedAgendaItems,
    numbering: s.numbering,
    tasksSection: s.tasks.on ? { label: tasksLabel, groupBy: s.tasks.groupBy } : null,
    notesSection: s.notes.on ? { label: notesLabel } : null,
    decisionPrefix: VECKOMOTE.decisionPrefix,
    taskStyle: VECKOMOTE.taskStyle,
    tone: VECKOMOTE.tone,
    signatures: signatures.length ? signatures : null,
    requiredItems,
    ...(name ? { name } : {}),
    // Only stored when on, and only with a Må-runda item to hide.
    ...(s.hideCheckin && s.items.some((i) => i.role === "checkin") ? { hideCheckin: true } : {}),
  });
  if (!parsed.success) return { ok: false, errors: [e("formatEditor.errors.invalid")] };
  return { ok: true, profile: parsed.data as FormatProfile };
}
