import { getEnv } from "@/lib/env";

/** Pure: is `email` in the comma list `adminEmails` (case-insensitive), else equal to `fallback`? */
export function isAdminEmail(email: string | null | undefined, adminEmails: string | undefined, fallback: string): boolean {
  if (!email) return false;
  const list = (adminEmails ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const allowed = list.length > 0 ? list : [fallback.trim().toLowerCase()];
  return allowed.includes(email.trim().toLowerCase());
}

/** May this signed-in email run Testmöte? ADMIN_EMAILS, falling back to ALARM_EMAIL. */
export function canRunTestMeeting(email: string | null | undefined): boolean {
  const env = getEnv();
  return isAdminEmail(email, env.ADMIN_EMAILS, env.ALARM_EMAIL);
}
