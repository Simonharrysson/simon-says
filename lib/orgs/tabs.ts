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
