// Every kind of e-mail Simon Says sends, in one place. Pure (client and server).
//
// User-facing categories can be turned off per person (Konto → Mejl, or the link in every mail);
// lib/email/prefs.ts mayEmail() is the gate every user-facing send goes through. Adding a
// category: add it here AND replace public.email_categories() in a migration (0039; the one list
// in the database, used by every constraint and writer; categories.test.ts compares the two).
//
// Not here on purpose: the operator's own mail (spend alarm, daily summary, "mötet avslutades
// utan slutpass" in lib/alarm.ts and lib/meetings/tick.ts). Those go to ALARM_EMAIL, the
// operator's env address, never to users, so there is nothing for a user to turn off.

export const EMAIL_CATEGORIES = ["meeting_summary", "invite"] as const;

export type EmailCategory = (typeof EMAIL_CATEGORIES)[number];

export interface EmailCategoryInfo {
  label: string;
  description: string;
}

export const EMAIL_CATEGORY_INFO: Record<EmailCategory, EmailCategoryInfo> = {
  meeting_summary: {
    label: "Sammanfattning efter möten",
    description: "Anteckningarna från ett möte du missade, eller från alla möten om föreningen valt det.",
  },
  invite: {
    label: "Inbjudningar",
    description: "När en förening bjuder in dig till Simon Says, och påminnelser om inbjudan.",
  },
};

export function isEmailCategory(value: unknown): value is EmailCategory {
  return typeof value === "string" && (EMAIL_CATEGORIES as readonly string[]).includes(value);
}

/** One person's choices. No stored row = everything on. */
export interface EmailPrefs {
  /** "Inga mejl alls": wins over every category, which keep their own values underneath. */
  allOff: boolean;
  off: EmailCategory[];
}

export const ALL_ON: EmailPrefs = { allOff: false, off: [] };

/** Would a mail of this category go out under these choices? */
export function allows(prefs: EmailPrefs, category: EmailCategory): boolean {
  return !prefs.allOff && !prefs.off.includes(category);
}

/** Known categories only, deduplicated, in list order. */
export function cleanOff(values: readonly unknown[]): EmailCategory[] {
  return EMAIL_CATEGORIES.filter((c) => values.includes(c));
}

/** Turn one category on or off, keeping the rest. */
export function withCategory(prefs: EmailPrefs, category: EmailCategory, on: boolean): EmailPrefs {
  const off = on ? prefs.off.filter((c) => c !== category) : [...prefs.off, category];
  return { allOff: prefs.allOff, off: cleanOff(off) };
}
