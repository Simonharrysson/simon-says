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
    { key: "previous", label: "Föregående protokoll", role: "followup" },
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

export const STANDARD = { veckomote: VECKOMOTE, styrelseprotokoll: STYRELSEPROTOKOLL, enkel: ENKEL } as const;

export const FORMAT_NAMES: Record<FormatKind, string> = {
  veckomote: "Veckomöte",
  styrelseprotokoll: "Styrelseprotokoll",
  enkel: "Enkel",
  learned: "Eget",
};
