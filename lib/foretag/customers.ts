// Företag customers (spec 2026-11-27 "Customers"): found from the calendar attendees' e-mail
// domains. Pure. Only the domain is ever stored, never an address.

/** Free-mail domains: never a customer (and never the company's own). */
export const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "outlook.se", "hotmail.com", "hotmail.se", "live.com", "live.se",
  "msn.com", "icloud.com", "me.com", "mac.com", "yahoo.com", "yahoo.se", "proton.me", "protonmail.com", "aol.com",
  "telia.com", "spray.se", "bredband.net", "gmx.com", "gmx.de",
]);

/** Second-level labels under which the name is one step further left (acme.co.uk). */
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov"]);

const DOMAIN = /^[a-z0-9.-]+\.[a-z]{2,}$/;

/** The domain of an address, lower case; null when malformed. */
export function domainOf(email: string): string | null {
  const at = email.trim().toLowerCase().lastIndexOf("@");
  if (at < 1) return null;
  const domain = email.trim().toLowerCase().slice(at + 1);
  return DOMAIN.test(domain) ? domain : null;
}

const isOwn = (domain: string, own: string[]) => own.some((o) => domain === o || domain.endsWith(`.${o}`));

/** The company's own domains: its members' sign-in domains (free mail excluded). */
export function ownDomains(memberEmails: string[]): string[] {
  const out: string[] = [];
  for (const e of memberEmails) {
    const d = domainOf(e);
    if (d && !FREE_MAIL.has(d) && !out.includes(d)) out.push(d);
  }
  return out;
}

/** The customer's domain among a meeting's attendees: the external domain with most attendees (first seen on a tie). */
export function customerDomain(emails: string[], own: string[]): string | null {
  const counts = new Map<string, number>();
  for (const e of emails) {
    const d = domainOf(e);
    if (!d || FREE_MAIL.has(d) || isOwn(d, own)) continue;
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [d, n] of counts) if (best === null || n > counts.get(best)!) best = d;
  return best;
}

/** A first name for a new customer: "acme.se" → "Acme", "nordic-tools.com" → "Nordic Tools". Renamable. */
export function customerName(domain: string): string {
  const labels = domain.split(".");
  let i = labels.length - 2;
  if (i > 0 && SECOND_LEVEL.has(labels[i])) i--;
  const base = labels[Math.max(i, 0)];
  return base
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toLocaleUpperCase("sv") + w.slice(1))
    .join(" ");
}
