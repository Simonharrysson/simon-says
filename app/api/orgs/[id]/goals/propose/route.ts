import { NextResponse, type NextRequest } from "next/server";
import { goalsInput, MIN_MEETINGS } from "@/lib/dashboard/goals-input";
import { proposeGoals } from "@/lib/dashboard/goals";
import { loadOverviewInput } from "@/lib/dashboard/load";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
// One Claude call (lib/dashboard/goals.ts) after a few DB reads.
export const maxDuration = 60;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) =>
  NextResponse.json({ error, message }, { status, headers: noStore });

/**
 * "Föreslå mål": proposes 3–5 goals from the förening's stored meeting structure (decisions,
 * tasks, agenda labels of real, ended meetings; never Doc text). Admins only. Stores nothing;
 * logs only counts. → `{ goals: [{ title, why }], explanation }`.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return fail("unauthenticated", 401, "Du är inte inloggad. Logga in och försök igen.");
  if (!isUuid(id)) return fail("not_found", 404, "Föreningen finns inte.");

  const role = await myRole(db, id);
  if (!role) return fail("not_found", 404, "Föreningen finns inte.");
  if (role !== "admin") return fail("forbidden", 403, "Bara administratörer kan ändra föreningens mål.");

  let summary;
  try {
    summary = goalsInput(id, await loadOverviewInput(db, id), new Date());
  } catch (err) {
    console.error(`goals/propose: ${(err as Error).message}`.slice(0, 200));
    return fail("error", 500, "Något gick fel. Försök igen om en liten stund.");
  }
  if (!summary) {
    return fail("too_few", 409, `Simon Says behöver minst ${MIN_MEETINGS} avslutade möten för att föreslå mål. Skriv egna mål så länge.`);
  }
  console.info(
    `goals/propose: ${summary.meetings} meetings, ${summary.topics.length} topics, ${summary.decisions.length} decisions, ${summary.openTasks.length} tasks`,
  );

  const res = await proposeGoals({ orgId: id, summary });
  if (!res.ok) {
    if (res.error === "spend") return fail("spend", 503, "Simon Says kan inte föreslå mål just nu. Försök igen i morgon eller skriv egna mål.");
    return fail(res.error, 502, "Simon Says kunde inte föreslå mål. Försök igen eller skriv egna mål.");
  }
  return NextResponse.json({ goals: res.goals, explanation: res.explanation }, { headers: noStore });
}
