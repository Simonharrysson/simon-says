import { NextResponse, type NextRequest } from "next/server";
import { apiT } from "@/lib/i18n/api";
import { isUuid } from "@/lib/db/ids";
import { getOrg, listPeople, myRole } from "@/lib/db/orgs";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { boardFromWebsite } from "@/lib/website/fetch-board";

export const dynamic = "force-dynamic";
// Robots, three pages (5 s each at most) and one Claude call.
export const maxDuration = 60;

// "Hämta styrelsen från webbplatsen" (föreningar, admins): reads the förening's SAVED website and
// returns suggested board members. Saves nothing: the admin confirms each person, who is then
// added with the normal board action. A route, not a server action, so a slow site never holds
// up the page's other actions. Limited per förening (claim_website_fetch, 0057).

const HOUR_LIMIT = 5;
const DAY_LIMIT = 20;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) => NextResponse.json({ error, message }, { status, headers: noStore });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const t = apiT(request);
  const { id } = await params;
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return fail("unauthenticated", 401, t("api.unauthenticated"));
  if (!isUuid(id)) return fail("not_found", 404, t("api.orgNotFound"));
  const role = await myRole(db, id);
  if (!role) return fail("not_found", 404, t("api.orgNotFound"));
  if (role !== "admin") return fail("forbidden", 403, t("api.websiteBoard.adminsOnly"));
  const org = await getOrg(db, id);
  if (!org || (org.kind && org.kind !== "forening")) return fail("not_found", 404, t("api.orgNotFound"));
  if (!org.website_url) return fail("no_website", 400, t("api.websiteBoard.noWebsite"));

  // Service role only after the admin check above.
  const admin = supabaseAdmin();
  const { data: claim, error: claimError } = await admin.rpc("claim_website_fetch", { p_org_id: id, p_hour_limit: HOUR_LIMIT, p_day_limit: DAY_LIMIT });
  if (claimError) {
    console.error(`website board: claim: ${claimError.message}`.slice(0, 200));
    return fail("unavailable", 503, t("api.websiteBoard.failed"));
  }
  if (claim === null) return fail("rate_limited", 429, t("api.websiteBoard.limit"));

  const people = await listPeople(db, id);
  const result = await boardFromWebsite(org.website_url, { orgId: id, existingNames: people.map((p) => p.name) }).catch(() => ({ ok: false as const, reason: "network" as const }));
  const outcome = result.ok ? (result.people.length ? "ok" : "empty") : result.reason;
  // Reason codes only: never the URL, page text or names.
  if (!result.ok) console.error(`website board: ${outcome}`);
  const { error: logError } = await admin
    .from("website_fetches")
    .update({ outcome, found: result.ok ? result.people.length : null })
    .eq("id", claim as number);
  if (logError) console.error(`website board: log: ${logError.message}`.slice(0, 200));

  if (!result.ok) return fail(result.reason, 502, t(result.reason === "robots" ? "api.websiteBoard.robots" : "api.websiteBoard.failed"));
  return NextResponse.json({ people: result.people }, { headers: noStore });
}
