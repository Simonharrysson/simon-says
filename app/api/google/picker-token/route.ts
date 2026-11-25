import { NextResponse, type NextRequest } from "next/server";
import { getEnv, pickerEnabled } from "@/lib/env";
import { getGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) =>
  NextResponse.json({ error, message }, { status, headers: noStore });

/**
 * A short-lived access token of the signed-in user's own Google grant, for the Google Picker in
 * the browser, plus the Picker's developer key and app id (the Cloud project number, required for
 * drive.file grants). Returns `{ accessToken, expiresAt, developerKey, appId }` only: never the
 * refresh token. 503 `picker_off` when the Picker is not configured.
 */
export async function POST(_request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("unauthenticated", 401, "Du är inte inloggad. Logga in och försök igen.");

  const env = getEnv();
  if (!pickerEnabled(env)) return fail("picker_off", 503, "Google-väljaren är inte inställd än.");

  let accessToken: string | null | undefined;
  let expiresAt: number | null | undefined;
  try {
    // getGoogleAuth has already fetched a fresh access token.
    const { credentials } = await getGoogleAuth(user.id);
    accessToken = credentials.access_token;
    expiresAt = credentials.expiry_date;
  } catch (err) {
    if (err instanceof GoogleAuthLostError) {
      return fail("google_auth_lost", 401, "Kopplingen till ditt Google-konto har gått ut. Logga ut och in igen.");
    }
    console.error(`picker-token: google auth: ${(err as Error).message}`);
    return fail("google_unavailable", 502, "Vi nådde inte Google just nu. Försök igen om en liten stund.");
  }
  if (!accessToken) return fail("google_unavailable", 502, "Vi nådde inte Google just nu. Försök igen om en liten stund.");

  return NextResponse.json(
    {
      accessToken,
      expiresAt: expiresAt ?? Date.now() + 50 * 60_000,
      developerKey: env.GOOGLE_PICKER_API_KEY!,
      appId: env.GOOGLE_PROJECT_NUMBER!,
    },
    { headers: noStore },
  );
}
