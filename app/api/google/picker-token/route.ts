import { NextResponse, type NextRequest } from "next/server";
import { apiT } from "@/lib/i18n/api";
import { getEnv, pickerEnabled } from "@/lib/env";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { GoogleAuthLostError } from "@/lib/google/client";
import { DriveAccountLostError, pickerAuth } from "@/lib/google/drive-account";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) =>
  NextResponse.json({ error, message }, { status, headers: noStore });

/**
 * A short-lived access token of the signed-in user's own Google grant, for the Google Picker in
 * the browser, plus the Picker's developer key and app id (the Cloud project number, required for
 * drive.file grants). Returns `{ accessToken, expiresAt, developerKey, appId, account }` only: never
 * the refresh token. 503 `picker_off` when the Picker is not configured.
 *
 * Body `{ orgId }` (optional): in that förening, the admin who connected the förening's Drive
 * account (0070) gets a token of THAT account (`account`: its address), so the Picker shows the
 * förening's Drive. Everyone else, and every call without `orgId`, gets their own (`account: null`).
 */
export async function POST(request: NextRequest) {
  const t = apiT(request);
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("unauthenticated", 401, t("api.unauthenticated"));

  const env = getEnv();
  if (!pickerEnabled(env)) return fail("picker_off", 503, t("api.pickerOff"));

  const body = (await request.json().catch(() => null)) as { orgId?: unknown } | null;
  const rawOrg = typeof body?.orgId === "string" ? body.orgId : null;
  // Only an admin's request ever looks at the förening's account.
  const orgId = rawOrg && isUuid(rawOrg) && (await myRole(supabase, rawOrg)) === "admin" ? rawOrg : null;

  let accessToken: string | null | undefined;
  let expiresAt: number | null | undefined;
  let account: string | null = null;
  try {
    // pickerAuth has already fetched a fresh access token.
    const picked = await pickerAuth(user.id, orgId);
    accessToken = picked.auth.credentials.access_token;
    expiresAt = picked.auth.credentials.expiry_date;
    account = picked.account?.email ?? null;
  } catch (err) {
    if (err instanceof DriveAccountLostError) return fail("drive_account_lost", 409, t("api.driveAccountLost"));
    if (err instanceof GoogleAuthLostError) {
      return fail("google_auth_lost", 401, t("api.googleAuthLost"));
    }
    console.error(`picker-token: google auth: ${(err as Error).message}`);
    return fail("google_unavailable", 502, t("api.googleUnavailable"));
  }
  if (!accessToken) return fail("google_unavailable", 502, t("api.googleUnavailable"));

  return NextResponse.json(
    {
      accessToken,
      expiresAt: expiresAt ?? Date.now() + 50 * 60_000,
      developerKey: env.GOOGLE_PICKER_API_KEY!,
      appId: env.GOOGLE_PROJECT_NUMBER!,
      account,
    },
    { headers: noStore },
  );
}
