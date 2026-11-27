import { getEnv } from "@/lib/env";
import { isAdminEmail } from "@/lib/testmeeting/admin";

// Who may create a Företag (spec "Gate"): only Harrysson & Company until a DPA, its subprocessor
// list and a legal review exist. FORETAG_CREATOR_EMAILS, else ADMIN_EMAILS, else ALARM_EMAIL.

/** Pure, for tests. */
export function mayCreateForetag(email: string | null | undefined, env: { FORETAG_CREATOR_EMAILS?: string; ADMIN_EMAILS?: string; ALARM_EMAIL: string }): boolean {
  return isAdminEmail(email, env.FORETAG_CREATOR_EMAILS || env.ADMIN_EMAILS, env.ALARM_EMAIL);
}

export function canCreateForetag(email: string | null | undefined): boolean {
  return mayCreateForetag(email, getEnv());
}
