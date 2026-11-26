// Every `?fel=` / `?klart=` code the server actions and callback redirect with, mapped to copy
// (lib/i18n/messages/*/notices.json). Codes are produced in app/login/actions.ts,
// app/auth/callback/route.ts and app/(app)/orgs/actions.ts; keep them in sync.

import { defaultLocale, type Locale } from "@/lib/i18n/config";
import { messages } from "@/lib/i18n/messages";

/** `code` is the `?fel=` / `?klart=` code it came from (views match on it, never on the text). */
export type Notice = { tone: "danger" | "success"; title?: string; text: string; code?: string };

type Copy = { title?: string; text: string };

const copy = (locale: Locale) => messages[locale].notices;

export function loginErrors(locale: Locale = defaultLocale): Record<string, { title: string; text: string }> {
  return copy(locale).login;
}

export function loginError(code: string | undefined, locale: Locale = defaultLocale) {
  if (!code) return null;
  const errors = loginErrors(locale);
  return errors[code] ?? errors.kod;
}

const orgsTones: Record<string, Notice["tone"]> = {
  limit: "danger",
  cap: "danger",
  invalid: "danger",
  inbjudan: "danger",
  raderad: "success",
  lamnat: "success",
};

const orgTones: Record<string, Notice["tone"]> = {
  namn: "danger",
  personnamn: "danger",
  rollnamn: "danger",
  "roll-admin": "danger",
  sammanfattning: "danger",
  kalender: "danger",
  "mote-forbidden": "danger",
  "mote-not_found": "danger",
  "mote-active": "danger",
  "org-active": "danger",
  "org-name_mismatch": "danger",
  "org-forbidden": "danger",
  "org-not_found": "danger",
  avslutat: "success",
  "avsluta-forbidden": "danger",
  "avsluta-not_found": "danger",
  mote: "success",
  medlem: "success",
  "medlem-last_admin": "danger",
  "medlem-not_member": "danger",
  "medlem-forbidden": "danger",
  "medlem-not_found": "danger",
  "admin-ny": "success",
  "admin-bort": "success",
  "admin-last_admin": "danger",
  "admin-forbidden": "danger",
  "admin-not_member": "danger",
  "admin-not_found": "danger",
  "admin-invalid": "danger",
};

function pick(tones: Record<string, Notice["tone"]>, texts: Record<string, Copy>, fel?: string, klart?: string): Notice | null {
  const code = (fel && Object.hasOwn(tones, fel) && fel) || (klart && Object.hasOwn(tones, klart) && klart) || null;
  if (!code) return null;
  const text = texts[code];
  return { tone: tones[code], ...(text.title ? { title: text.title } : {}), text: text.text, code };
}

export const orgsNotice = (fel?: string, klart?: string, locale: Locale = defaultLocale) =>
  pick(orgsTones, copy(locale).orgs, fel, klart);
export const orgNotice = (fel?: string, klart?: string, locale: Locale = defaultLocale) =>
  pick(orgTones, copy(locale).org, fel, klart);
