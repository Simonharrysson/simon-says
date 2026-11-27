import { refuseForetag } from "@/lib/foretag/guard";
import { NextResponse, type NextRequest } from "next/server";
import { apiT } from "@/lib/i18n/api";
import type { Translator } from "@/lib/i18n/translator";
import { goalsInput, MIN_MEETINGS } from "@/lib/dashboard/goals-input";
import { proposeGoals } from "@/lib/dashboard/goals";
import { loadOverviewInput } from "@/lib/dashboard/load";
import { digestGoals } from "@/lib/history/digest";
import { MAX_HISTORY_CHARS, mergeHistory, ownHistory, splitForApproval } from "@/lib/history/digest-input";
import { loadImportedHistory } from "@/lib/history/store";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
// One Claude call after a few DB reads: lib/dashboard/goals.ts, or with imported protocols the
// whole-history digest (lib/history/digest.ts, up to ~4 min for a long history).
export const maxDuration = 300;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) =>
  NextResponse.json({ error, message }, { status, headers: noStore });

/**
 * "Föreslå mål": proposes 3–5 goals from the förening's stored meeting structure (decisions,
 * tasks, agenda labels of real, ended meetings; never Doc text). Admins only, at most 3 per
 * förening per 24 h (claim_goal_proposal). Stores no proposal;
 * logs only counts. → `{ goals: [{ title, why }], explanation }`.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const t = apiT(request);
  const { id } = await params;
  // Förening only: never for a Företag (0050, lib/foretag/guard.ts).
  const foretagRefusal = await refuseForetag(id);
  if (foretagRefusal) return foretagRefusal;
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return fail("unauthenticated", 401, t("api.unauthenticated"));
  if (!isUuid(id)) return fail("not_found", 404, t("api.orgNotFound"));

  const role = await myRole(db, id);
  if (!role) return fail("not_found", 404, t("api.orgNotFound"));
  if (role !== "admin") return fail("forbidden", 403, t("api.goalsAdminsOnly"));

  let summary;
  let history;
  let names: string[] = [];
  try {
    const [input, imported] = await Promise.all([
      loadOverviewInput(db, id),
      // Before 0032 is applied (deploy order) the tables are missing: the proposal works as before.
      loadImportedHistory(db, id).catch((err: Error) => {
        console.error(`goals/propose: history: ${err.message}`.slice(0, 200));
        return [];
      }),
    ]);
    names = input.people.map((p) => p.name);
    // Imported protocols (0032): the whole history, old protocols and Simon Says' own meetings.
    if (imported.length) history = mergeHistory(imported, ownHistory(id, input));
    else summary = goalsInput(id, input, new Date());
  } catch (err) {
    console.error(`goals/propose: ${(err as Error).message}`.slice(0, 200));
    return fail("error", 500, t("api.generic"));
  }
  if (history) return proposeFromHistory(db, id, history, names, t);
  if (!summary) {
    return fail("too_few", 409, t("api.goalsTooFewMeetings", { min: MIN_MEETINGS }));
  }
  // At most 3 proposals per förening per 24 h (0028): the daily Claude cap is shared by every
  // förening's live notes, so one admin must not be able to use it up.
  const { data: allowed, error: claimError } = await db.rpc("claim_goal_proposal", { p_org_id: id });
  if (claimError) {
    if (claimError.code === "42501") return fail("forbidden", 403, t("api.goalsAdminsOnly"));
    console.error(`goals/propose: claim: ${claimError.message}`.slice(0, 200));
    return fail("error", 500, t("api.generic"));
  }
  if (allowed !== true) return fail("rate_limited", 429, t("api.goalsRateLimited"));

  console.info(
    `goals/propose: ${summary.meetings} meetings, ${summary.topics.length} topics, ${summary.decisions.length} decisions, ${summary.openTasks.length} tasks`,
  );

  const res = await proposeGoals({ orgId: id, summary });
  if (!res.ok) {
    if (res.error === "spend") return fail("spend", 503, t("api.goalsSpend"));
    return fail(res.error, 502, t("api.goalsFailed"));
  }
  return NextResponse.json({ goals: res.goals, explanation: res.explanation }, { headers: noStore });
}

/**
 * The whole-history path (todo #7): ≥ MIN_MEETINGS meetings, the same 3-per-24-h claim, one
 * digest call. → `{ goals, explanation, source: "history", others }`: `goals` are the current
 * ones the editor starts with (at most 5), `others` the rest with their status (achieved,
 * dropped, stale, or current beyond 5) for the admin to add if they want. Nothing is stored.
 */
async function proposeFromHistory(
  db: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  id: string,
  history: ReturnType<typeof mergeHistory>,
  names: string[],
  t: Translator,
) {
  if (history.length < MIN_MEETINGS) {
    return fail("too_few", 409, t("api.goalsTooFew", { min: MIN_MEETINGS }));
  }
  if (JSON.stringify(history).length > MAX_HISTORY_CHARS) {
    return fail("too_long", 413, t("api.historyTooLong"));
  }
  const { data: allowed, error: claimError } = await db.rpc("claim_goal_proposal", { p_org_id: id });
  if (claimError) {
    if (claimError.code === "42501") return fail("forbidden", 403, t("api.goalsAdminsOnly"));
    console.error(`goals/propose: claim: ${claimError.message}`.slice(0, 200));
    return fail("error", 500, t("api.generic"));
  }
  if (allowed !== true) return fail("rate_limited", 429, t("api.goalsRateLimited"));

  console.info(`goals/propose: history of ${history.length} meetings (${history.filter((m) => m.source === "import").length} imported)`);
  const res = await digestGoals({ orgId: id, history, names });
  if (!res.ok) {
    if (res.error === "spend") return fail("spend", 503, t("api.goalsSpend"));
    return fail(res.error, 502, t("api.goalsFailed"));
  }
  console.info(`goals/propose: ${res.goals.length} goals, ${res.demoted} demoted to stale, ${res.droppedEvidence} evidence lines dropped`);
  const { approve, others } = splitForApproval(res.goals);
  return NextResponse.json({ goals: approve, explanation: res.explanation, source: "history", others }, { headers: noStore });
}
