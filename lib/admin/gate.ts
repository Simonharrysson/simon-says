import { isAdminEmail } from "@/lib/testmeeting/admin";

/** The internal dashboard's path (app/(app)/admin). Linked from nowhere. */
export const ADMIN_PATH = "/admin";

/** Is this a path of the internal dashboard (`/admin` and below)? */
export function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_PATH || pathname.startsWith(`${ADMIN_PATH}/`);
}

/**
 * May this signed-in e-mail see /admin? Only the ADMIN_EMAILS list. Unlike Testmöte there is no
 * ALARM_EMAIL fallback: with ADMIN_EMAILS unset nobody gets in (fails closed).
 */
export function mayOpenAdmin(email: string | null | undefined, env: { ADMIN_EMAILS?: string }): boolean {
  if (!env.ADMIN_EMAILS?.split(",").some((e) => e.trim())) return false;
  return isAdminEmail(email, env.ADMIN_EMAILS, "");
}
