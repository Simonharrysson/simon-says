import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { e2eMode } from "@/lib/e2e/guard";
import { storeGoogleToken } from "@/lib/google/client";
import { GOOGLE_SCOPES } from "@/lib/google/scopes";
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
 * with a one-time password (the session lands in the same httpOnly cookies the callback sets),
 * stores a fake Google refresh token with the sign-in scopes (the fake Google server knows it),
 * and redirects to `next` like the callback does.
 */
export async function GET(request: NextRequest) {
  if (!e2eMode()) return new NextResponse(null, { status: 404 });
  const email = (request.nextUrl.searchParams.get("email") ?? "").trim().toLowerCase();
  if (!email.endsWith(TEST_DOMAIN) || email.length > 200) return NextResponse.json({ error: "bad_email" }, { status: 400 });
  const next = safeNextPath(request.nextUrl.searchParams.get("next"));

  const admin = supabaseAdmin();
  const password = `e2e-${randomUUID()}`;
  let userId = await findUser(email);
  if (userId) {
    const { error } = await admin.auth.admin.updateUserById(userId, { password });
    if (error) return NextResponse.json({ error: `update: ${error.message}` }, { status: 500 });
  } else {
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    // A parallel first login of the same address: the other one created it.
    userId = data.user?.id ?? (error ? await findUser(email) : null);
    if (!userId) return NextResponse.json({ error: `create: ${error?.message}` }, { status: 500 });
    if (error) await admin.auth.admin.updateUserById(userId, { password });
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return NextResponse.json({ error: `sign-in: ${error.message}` }, { status: 500 });
  await storeGoogleToken(userId, `e2e-refresh:${email}`, GOOGLE_SCOPES.join(" "));
  return NextResponse.redirect(`${appOrigin()}${next}`);
}

async function findUser(email: string): Promise<string | null> {
  const admin = supabaseAdmin();
  for (let page = 1; page < 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 1000) return null;
  }
  return null;
}
