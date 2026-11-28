"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isUuid } from "@/lib/db/ids";
import { getOrg, myRole } from "@/lib/db/orgs";
import { isForetagOrg } from "@/lib/foretag/guard";
import { deleteOrgDriveAccount, orgDriveAccount } from "@/lib/google/drive-account";
import { mayDisconnect } from "@/lib/google/drive-account-rules";
import {
  returnPath,
  startDriveAccountFlow,
  STATE_COOKIE,
  STATE_COOKIE_PATH,
  STATE_TTL_SECONDS,
  type DriveAccountReturn,
} from "@/lib/google/drive-account-oauth";
import { withParam } from "@/lib/next-path";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// "Använd ett annat Google-konto" / "Byt konto" / "Koppla från" in the folder card (Kom igång's
// step 3 and Inställningar › Möten). Admins of a förening only (never a Företag or a Privat space).

const fromOf = (v: FormDataEntryValue | null): DriveAccountReturn => (v?.toString() === "kom-igang" ? "kom-igang" : "installningar");
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

/** The signed-in admin of a förening, or a redirect. */
async function adminOf(orgId: string) {
  if (!isUuid(orgId)) redirect("/");
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");
  const org = await getOrg(db, orgId);
  if (!org || org.kind === "privat" || (await isForetagOrg(orgId))) redirect("/");
  const role = await myRole(db, orgId);
  return { user, role };
}

/** Starts Google's consent for the förening's Drive account (state cookie, then Google). */
export async function connectDriveAccount(formData: FormData): Promise<void> {
  const orgId = formData.get("orgId")?.toString() ?? "";
  const from = fromOf(formData.get("from"));
  const { user, role } = await adminOf(orgId);
  if (role !== "admin") redirect(`/orgs/${orgId}`);
  const hint = formData.get("hint")?.toString().trim() ?? "";
  const { cookie, url } = startDriveAccountFlow({ userId: user.id, orgId, from, loginHint: EMAIL.test(hint) ? hint : null });
  (await cookies()).set(STATE_COOKIE, cookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: STATE_COOKIE_PATH,
    maxAge: STATE_TTL_SECONDS,
  });
  redirect(url);
}

/** "Koppla från": an admin, or whoever connected it. Our copy only (see deleteOrgDriveAccount). */
export async function disconnectDriveAccount(formData: FormData): Promise<void> {
  const orgId = formData.get("orgId")?.toString() ?? "";
  const from = fromOf(formData.get("from"));
  const { user, role } = await adminOf(orgId);
  const back = returnPath(orgId, from);
  const account = await orgDriveAccount(orgId);
  if (!account) redirect(back);
  if (!mayDisconnect(account, user.id, role === "admin")) redirect(`/orgs/${orgId}`);
  let result = "bort";
  try {
    await deleteOrgDriveAccount(orgId);
    console.info(`org drive ${orgId}: disconnected by ${user.id}`);
  } catch (err) {
    console.error(`org drive ${orgId}: disconnect: ${(err as Error).message}`);
    result = "fel";
  }
  revalidatePath(`/orgs/${orgId}`, "layout");
  redirect(withParam(back, "drivekonto", result));
}
