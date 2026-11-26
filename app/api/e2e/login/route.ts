import { NextResponse, type NextRequest } from "next/server";
import { e2eMode } from "@/lib/e2e/guard";
import { storeGoogleToken, storeImportToken } from "@/lib/google/client";
import { GOOGLE_SCOPES, IMPORT_SCOPES } from "@/lib/google/scopes";
import { safeNextPath } from "@/lib/next-path";
import { appOrigin } from "@/lib/origin";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Only addresses of this test domain can be signed in here. */
const TEST_DOMAIN = "@e2e.test";

/**
 * TEST ONLY (e2e/, docs/testing.md "E2E"): stands in for Google sign-in + /auth/callback. A 404
 * unless lib/e2e/guard.ts `e2eMode()` holds (flag, not production, not Vercel, loopback Supabase).
 *
 * `GET /api/e2e/login?email=<x>@e2e.test&next=/path`: creates the user on first use, signs in
 * with a magic link verified here (the session lands in the same httpOnly cookies the callback sets),
 * stores a fake Google refresh token with the sign-in scopes (the fake Google server knows it),
 * and redirects to `next` like the callback does. `&drive=1` stands in for the protocol import's
 * drive.readonly consent instead: it also stores the import token and returns `next?drive=ok`.
 */
const failed = (what: string, message: string | undefined) => {
  console.error(`e2e login: ${what}: ${message}`);
  return NextResponse.json({ error: `${what}: ${message}` }, { status: 500 });
};

export async function GET(request: NextRequest) {
  if (!e2eMode()) return new NextResponse(null, { status: 404 });
  const email = (request.nextUrl.searchParams.get("email") ?? "").trim().toLowerCase();
  if (!email.endsWith(TEST_DOMAIN) || email.length > 200) return NextResponse.json({ error: "bad_email" }, { status: 400 });
  const next = safeNextPath(request.nextUrl.searchParams.get("next"));

  // A magic link verified on the server: a new session in the same httpOnly cookies the callback
  // sets, without touching the user's password or other sessions. Fallback: a one-time password.
  const admin = supabaseAdmin();
  const supabase = await createSupabaseServerClient();
  let userId: string | undefined;
  // A confirmed user first (a magic link for an unknown address would be a sign-up link).
  const created = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (created.error && !/already/i.test(created.error.message)) return failed("create", created.error.message);
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  userId = link.data.user?.id;
  const tokenHash = link.data.properties?.hashed_token;
  const verified = tokenHash ? await supabase.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash }) : null;
  if (!verified || verified.error || !userId) {
    console.warn(`e2e login: magic link failed (${link.error?.message ?? verified?.error?.message ?? "no token"}), using a password`);
    if (!userId) return failed("link", link.error?.message);
    const password = `e2e-${crypto.randomUUID()}`;
    const upd = await admin.auth.admin.updateUserById(userId, { password, email_confirm: true });
    if (upd.error) return failed("password", upd.error.message);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return failed("sign-in", error.message);
  }
  await storeGoogleToken(userId, `e2e-refresh:${email}`, GOOGLE_SCOPES.join(" "));
  if (request.nextUrl.searchParams.get("drive") === "1") {
    await storeImportToken(userId, `e2e-refresh:${email}`, IMPORT_SCOPES.join(" "));
    return NextResponse.redirect(`${appOrigin()}${next}?drive=ok`);
  }
  return NextResponse.redirect(`${appOrigin()}${next}`);
}

