// Which tab of the förening page to show (Möten, Översikt, Inställningar). Pure.
//
// `?flik=` picks it; Inställningar is for admins only (anyone else gets Möten). Server actions
// redirect to the bare page with `?fel=` / `?klart=`: a code that belongs to a setting opens
// Inställningar, so the message shows next to what it is about (the actions stay unchanged).
// "Koppla kalender" in Inställningar returns through `/orgs/<id>/installningar` (a plain path).

export type OrgTabId = "moten" | "oversikt" | "installningar";

/** `?fel=` / `?klart=` codes of Inställningar's forms (lib/ui/messages.ts, app/(app)/orgs/actions.ts). */
export function isSettingsCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return ["namn", "personnamn", "sammanfattning", "kalender", "medlem", "rollnamn", "roll-admin"].includes(code) || /^(medlem|admin|org)-/.test(code);
}

export function orgTab(input: {
  flik?: string;
  isAdmin: boolean;
  /** The page notice's code (`?fel=` / `?klart=`), if any. */
  noticeCode?: string | null;
}): OrgTabId {
  const { flik, isAdmin } = input;
  if (flik === "oversikt") return "oversikt";
  if (!isAdmin) return "moten";
  if (flik === "installningar") return "installningar";
  if (flik) return "moten";
  if (isSettingsCode(input.noticeCode)) return "installningar";
  return "moten";
}

/** The link of each tab. */
export function orgTabHref(orgId: string, tab: OrgTabId): string {
  return tab === "moten" ? `/orgs/${orgId}` : `/orgs/${orgId}?flik=${tab}`;
}

// Inställningar's sections (`?flik=installningar&del=`): every setting of the förening lives in
// exactly one of them. Without `del`, a settings form's message picks the section it is about.

export const SETTINGS_SECTIONS = ["foreningen", "styrelsen", "moten", "efter-motet", "radera"] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];

export const isSettingsSection = (v: unknown): v is SettingsSectionId => typeof v === "string" && (SETTINGS_SECTIONS as readonly string[]).includes(v);

/** The section a `?fel=` / `?klart=` code belongs to (null: none in particular). */
export function sectionForCode(code: string | null | undefined): SettingsSectionId | null {
  if (!code) return null;
  if (code === "namn") return "foreningen";
  if (code === "sammanfattning") return "efter-motet";
  if (code === "kalender" || code.startsWith("kalender-")) return "moten";
  if (code.startsWith("org-")) return "radera";
  if (["personnamn", "rollnamn", "roll-admin", "medlem"].includes(code) || /^(medlem|admin)-/.test(code)) return "styrelsen";
  // Grupper (0054) sits under Styrelsen och medlemmar.
  if (["grupp", "grupp-arkiv", "placering", "grupper"].includes(code)) return "styrelsen";
  return null;
}

/** The section to open: `?del=`, else the one a form's message is about (`notice`, or its code), else Föreningen. */
export function settingsSection(input: { del?: string | null; notice?: SettingsSectionId | null; noticeCode?: string | null }): SettingsSectionId {
  if (isSettingsSection(input.del)) return input.del;
  return input.notice ?? sectionForCode(input.noticeCode) ?? "foreningen";
}

/** The link to one section of Inställningar. */
export function settingsHref(orgId: string, section: SettingsSectionId): string {
  return `${orgTabHref(orgId, "installningar")}&del=${section}`;
}

/** Old anchors of the one long page (summary e-mails link `#sammanfattning`) → their section. */
export const HASH_SECTIONS: Record<string, SettingsSectionId> = {
  "#installningar": "foreningen",
  "#om-oss": "foreningen",
  "#styrelsen": "styrelsen",
  "#bjud-in": "styrelsen",
  "#kalender": "moten",
  "#sammanfattning": "efter-motet",
};
