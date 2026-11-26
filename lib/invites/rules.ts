// Invites by e-mail (todo "bjud in via mejl"): the rules shared by the form, the route and the
// tests. Pure. The database (0038, claim_invite_send) enforces the limits again, atomically.

import { cleanEmail } from "@/lib/people/board";

export const INVITE_LIMITS = {
  /** Sends (attempts) per förening in a rolling 24 h. */
  perOrgPerDay: 50,
  /** Sends (attempts) per admin in a rolling 24 h, across föreningar. */
  perUserPerDay: 200,
  /** Delivered e-mails per address in a rolling 24 h: the invite and one "Skicka igen". */
  perAddressPerDay: 2,
  /** Addresses in one request. */
  perRequest: 50,
} as const;

export interface ParsedEmails {
  /** Valid, lowercased, first occurrence kept. */
  valid: string[];
  /** As typed (trimmed), deduplicated. */
  invalid: string[];
  /** Addresses that appeared more than once (lowercased). */
  duplicates: string[];
}

/**
 * Splits what an admin pasted: commas, semicolons, whitespace and newlines separate addresses;
 * "Anna Berg <anna@example.com>" gives the address in the brackets.
 */
export function parseEmails(raw: string): ParsedEmails {
  const valid: string[] = [];
  const invalid: string[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();
  // "Anna Berg <anna@example.com>": keep only the address in the brackets.
  const text = raw.replace(/[^,;\n<>]*<([^<>]*)>/g, (_, inner: string) => ` ${inner} `);
  for (const token of text.split(/[\s,;]+/)) {
    const t = token.trim().replace(/^mailto:/i, "");
    if (!t) continue;
    const email = cleanEmail(t);
    const key = email ?? t.toLowerCase();
    if (seen.has(key)) {
      if (!duplicates.includes(key)) duplicates.push(key);
      continue;
    }
    seen.add(key);
    if (email) valid.push(email);
    else invalid.push(t);
  }
  return { valid, invalid, duplicates };
}

/** What happened to one address. */
export type InviteResult =
  | "sent"
  | "member" // already a member: nothing sent
  | "invalid"
  | "failed" // the mail provider did not take it: "Försök igen"
  | "already_invited" // delivered in the last 24 h; "Skicka igen" in the list
  | "resend_limit" // already sent twice in 24 h
  | "org_limit"
  | "user_limit"
  | "busy"; // another send to this address is in flight

export const RESULT_LABEL: Record<InviteResult, string> = {
  sent: "Skickat",
  member: "Redan medlem",
  invalid: "Ogiltig adress",
  failed: "Misslyckades",
  already_invited: "Redan inbjuden",
  resend_limit: "Skickat två gånger i dag",
  org_limit: "Dagens gräns för föreningen nådd",
  user_limit: "Din gräns för i dag nådd",
  busy: "Skickas redan",
};

/** Results worth a "Försök igen" (nothing was delivered, and trying again may work). */
export const RETRYABLE: ReadonlySet<InviteResult> = new Set<InviteResult>(["failed", "busy"]);

export type InviteStatus = "sending" | "sent" | "failed" | "accepted";

/** A sent invite as the list shows it (`org_invite_list`, 0038). */
export interface InviteRow {
  email: string;
  status: InviteStatus;
  /** Last delivered send, or null. */
  lastSentAt: string | null;
  acceptedAt: string | null;
  /** Delivered sends in the last 24 h. */
  recentSends: number;
  /** When "Skicka igen" opens again (the oldest of the recent sends + 24 h), or null. */
  nextResendAt: string | null;
}

export const STATUS_LABEL: Record<InviteStatus, string> = {
  sending: "Skickas",
  sent: "Skickad",
  failed: "Misslyckades",
  accepted: "Har gått med",
};

/** May "Skicka igen" be pressed now? Accepted invites need no resend. */
export function canResend(row: InviteRow, now: Date = new Date()): boolean {
  if (row.status === "accepted" || row.status === "sending") return false;
  if (row.recentSends < INVITE_LIMITS.perAddressPerDay) return true;
  return row.nextResendAt !== null && new Date(row.nextResendAt).getTime() <= now.getTime();
}
