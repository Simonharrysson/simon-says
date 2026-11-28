import { NextResponse, type NextRequest } from "next/server";
import { myRole, getOrg } from "@/lib/db/orgs";
import { isForetagOrg } from "@/lib/foretag/guard";
import { storeOrgDriveAccount } from "@/lib/google/drive-account";
import {
  checkDriveAccountState,
  exchangeDriveAccountCode,
  returnPath,
  STATE_COOKIE,
  STATE_COOKIE_PATH,
} from "@/lib/google/drive-account-oauth";
import { withParam } from "@/lib/next-path";
import { appOrigin } from "@/lib/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Google's answer to "Använd ett annat Google-konto" (lib/google/drive-account-oauth.ts). Only for
 * the user who started it (the sealed state), still an admin of the förening. Stores the förening's
 * account and returns to where it was asked: `?drivekonto=ok` (now pick the folder in that
 * account), `nej` (cancelled, or Drive unticked), `fel`. The session is never touched.
 * Logs ids and reasons only.
 */
export async function GET(request: NextRequest) {
  const origin = appOrigin();
  const params = request.nextUrl.searchParams;
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  const check = checkDriveAccountState(request.cookies.get(STATE_COOKIE)?.value, params.get("state"), user?.id ?? null);

  const done = (path: string) => {
    const res = NextResponse.redirect(`${origin}${path}`);
    res.cookies.set(STATE_COOKIE, "", { path: STATE_COOKIE_PATH, maxAge: 0, httpOnly: true, sameSite: "lax" });
    res.headers.set("cache-control", "no-store");
    return res;
  };

  if (!check.ok) {
    console.warn(`drive account callback: refused (${check.reason})`);
    return done(user ? "/" : "/login");
  }
  const back = returnPath(check.orgId, check.from);
  const result = (r: "ok" | "nej" | "fel") => done(withParam(back, "drivekonto", r));

  // Still an admin of a förening (the role may have changed during the consent).
  const org = await getOrg(db, check.orgId);
  if (!org || org.kind === "privat" || (await isForetagOrg(check.orgId)) || (await myRole(db, check.orgId)) !== "admin") {
    console.warn(`drive account callback: ${user!.id} is no longer an admin of ${check.orgId}`);
    return done(`/orgs/${check.orgId}`);
  }

  const code = params.get("code");
  if (!code) return result(params.get("error") === "access_denied" ? "nej" : "fel");

  try {
    const exchanged = await exchangeDriveAccountCode(code, check.verifier);
    if (!exchanged.ok) {
      console.warn(`drive account callback: ${check.orgId}: ${exchanged.reason}`);
      return result(exchanged.reason === "no_drive" ? "nej" : "fel");
    }
    const a = exchanged.account;
    await storeOrgDriveAccount({ orgId: check.orgId, connectedBy: user!.id, googleSub: a.sub, googleEmail: a.email, refreshToken: a.refreshToken, scope: a.scope });
    console.info(`drive account callback: ${check.orgId} connected by ${user!.id}`);
    return result("ok");
  } catch (err) {
    console.error(`drive account callback: ${check.orgId}: ${(err as Error).message}`.slice(0, 200));
    return result("fel");
  }
}
