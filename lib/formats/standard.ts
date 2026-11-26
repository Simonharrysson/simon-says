import { defaultLocale, type Locale } from "@/lib/i18n/config";
import { translator } from "@/lib/i18n/translator";
import type { FormatKind, FormatProfile } from "./schema";

// Structure only: labels, never any förening's real minutes.

export const VECKOMOTE: FormatProfile = {
  kind: "veckomote",
  title: "Mötesprotokoll",
  infoTable: ["Datum", "Tid", "Närvarande", "Sekreterare"],
  agendaHeading: "Agenda",
  fixedAgendaItems: [
    { key: "approve", label: "Godkänn dagordning", role: "procedural" },
    { key: "checkin", label: "Må-runda", role: "checkin" },
    { key: "followup", label: "Från förra veckan", role: "followup" },
    { key: "other", label: "Övrigt", role: "other", position: "last" },
  ],
  numbering: "numbered",
  tasksSection: { label: "Vad ska vi göra till nästa gång?", groupBy: "role" },
  notesSection: { label: "Anteckningar" },
  decisionPrefix: "Beslut:",
  taskStyle: "role-first",
  tone: "full-sentences",
  signatures: null,
  requiredItems: [],
};

// 8 fixed items here; the skeleton adds "Övriga punkter" (topic), so with one required item
// merged in (Phase C) the protocol numbers §1..§10.
export const STYRELSEPROTOKOLL: FormatProfile = {
  kind: "styrelseprotokoll",
  title: "Styrelseprotokoll",
  infoTable: ["Datum", "Tid", "Plats", "Närvarande"],
  agendaHeading: "Dagordning",
  fixedAgendaItems: [
    { key: "open", label: "Mötets öppnande", role: "procedural" },
    { key: "chair", label: "Val av mötesordförande", role: "procedural" },
    { key: "secretary", label: "Val av mötessekreterare", role: "procedural" },
    { key: "adjuster", label: "Val av justerare", role: "procedural" },
    { key: "approve", label: "Godkännande av dagordning", role: "procedural" },
    // Ruling R-C1: "other", not "followup", so the approval of the previous minutes ("Beslut: Att
    // godkänna föregående protokoll …") can sit under its §. No followup item: no Från förra
    // veckan pre-fill in this format.
    { key: "previous", label: "Föregående protokoll", role: "other" },
    { key: "other", label: "Övriga frågor", role: "other", position: "last" },
    { key: "close", label: "Mötets avslutande", role: "procedural", position: "last" },
  ],
  numbering: "paragraph",
  tasksSection: { label: "Att göra", groupBy: "role" },
  notesSection: null,
  decisionPrefix: "Beslut:",
  taskStyle: "role-first",
  tone: "full-sentences",
  signatures: ["Mötesordförande", "Mötessekreterare", "Justerare"],
  requiredItems: [],
};

export const ENKEL: FormatProfile = {
  kind: "enkel",
  title: "Anteckningar",
  infoTable: null,
  agendaHeading: null,
  fixedAgendaItems: [],
  numbering: "none",
  tasksSection: { label: "Att göra", groupBy: "person" },
  notesSection: { label: "Anteckningar" },
  decisionPrefix: "Beslut:",
  taskStyle: "role-first",
  tone: "full-sentences",
  signatures: null,
  requiredItems: [],
};

// Årsmöte (todo #6, design 2026-11-26): the standard agenda of a förening's annual meeting. The
// förening's own stadgar-derived agenda is onboarding (todo #5); "Lägg in punkter från
// stadgarna" can still add their required items to a version of this one later. No followup item.
export const ARSMOTE: FormatProfile = {
  kind: "arsmote",
  title: "Årsmötesprotokoll",
  infoTable: ["Datum", "Tid", "Plats", "Närvarande"],
  agendaHeading: "Dagordning",
  fixedAgendaItems: [
    { key: "open", label: "Mötets öppnande", role: "procedural" },
    { key: "chair", label: "Val av mötesordförande", role: "procedural" },
    { key: "secretary", label: "Val av mötessekreterare", role: "procedural" },
    { key: "adjuster", label: "Val av justerare", role: "procedural" },
    { key: "notice", label: "Fråga om mötet är stadgeenligt utlyst", role: "procedural" },
    { key: "report", label: "Verksamhetsberättelse", role: "other" },
    { key: "finance", label: "Ekonomisk berättelse", role: "other" },
    { key: "audit", label: "Revisionsberättelse", role: "other" },
    { key: "discharge", label: "Fråga om ansvarsfrihet för styrelsen", role: "other" },
    { key: "election", label: "Val av styrelse", role: "other" },
    { key: "motions", label: "Motioner och propositioner", role: "other" },
    { key: "other", label: "Övriga frågor", role: "other", position: "last" },
    { key: "close", label: "Mötets avslutande", role: "procedural", position: "last" },
  ],
  numbering: "paragraph",
  tasksSection: { label: "Att göra", groupBy: "role" },
  notesSection: null,
  decisionPrefix: "Beslut:",
  taskStyle: "role-first",
  tone: "full-sentences",
  signatures: ["Mötesordförande", "Mötessekreterare", "Justerare"],
  requiredItems: [],
};

export const STANDARD = { veckomote: VECKOMOTE, styrelseprotokoll: STYRELSEPROTOKOLL, enkel: ENKEL, arsmote: ARSMOTE } as const;
export type StandardKind = keyof typeof STANDARD;

export const FORMAT_NAMES: Record<FormatKind, string> = {
  veckomote: "Veckomöte",
  styrelseprotokoll: "Styrelseprotokoll",
  enkel: "Enkel",
  learned: "Ert format",
  arsmote: "Årsmöte",
};

/** A format's name in the UI language (FORMAT_NAMES above is the Swedish one, also used in Docs). */
export function formatName(kind: FormatKind, locale: Locale = defaultLocale): string {
  return translator(locale)(`formats.names.${kind}`);
}

/** "26 nov" / "Nov 26" in the UI language. */
function shortDate(iso: string, locale: Locale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return new Intl.DateTimeFormat(locale === "sv" ? "sv-SE" : "en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(d).replace(/\./g, "");
}

/** A saved format's display name: the standard name; "(date)" for learned and custom versions (R3-I2). */
export function formatLabel(f: { kind: FormatKind; createdAt: string; custom: boolean; requiredCount: number; name?: string }, locale: Locale = defaultLocale): string {
  const t = translator(locale);
  const date = f.createdAt.slice(0, 10);
  if (f.name) return f.name;
  const name = formatName(f.kind, locale);
  if (f.kind === "learned") return t("formats.labelLearned", { date: shortDate(f.createdAt, locale) });
  if (!f.custom) return name;
  return f.requiredCount > 0 ? t("formats.labelStatutes", { name, date }) : t("formats.labelCustom", { name, date });
}
