import { after, NextResponse, type NextRequest } from "next/server";
import { logEvent } from "@/lib/db/events";
import { isUuid } from "@/lib/db/ids";
import { memberRole } from "@/lib/db/orgs";
import { canEndMeeting } from "@/lib/meetings/access";
import { claimEnd, END_BUDGET_MS, finishMeeting, saveLateTaskAnswers } from "@/lib/meetings/tick";
import { parseEndStats, parseTaskAnswers } from "@/lib/notes/tasks";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
// The final notes pass (Claude + Docs) runs after the response, in after().
export const maxDuration = 300;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: noStore });

/**
 * End a meeting. Any member (whoever runs it ends it from the live page; the org page offers
 * it to admins and the starter). Atomically live → ending and answers at once
 * `{ result: "ending" }`; the final pass (close ElevenLabs sessions, final notes, header
 * `Avslutat HH:mm`, status done) runs after the response, and the cron retries it if this
 * function dies. The page polls the meeting until done. Works under KILL_SWITCH (no Claude then).
 * A meeting that is already ending or ended: `{ result: "noop" }`.
 * Body (optional, concrete tasks): `{ answers: [{ id, owner?, due?, doneWhen? }] }`, what the
 * Avsluta dialog filled in; stored with the claim and applied by the final pass (lib/notes/tasks.ts).
 * `stats` (optional): how the dialog was met, counts only (EndStats); logged once, as meeting_events
 * 'end_tasks', by the request that claims the end. Best effort: logging never fails the end.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("unauthenticated", 401);
  if (!isUuid(id)) return fail("not_found", 404);

  // As the user: RLS hides meetings of other orgs (404).
  const { data: meeting, error } = await supabase
    .from("meetings")
    .select("id, org_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`end: meeting: ${error.message}`);
  if (!meeting) return fail("not_found", 404);
  if (!canEndMeeting(await memberRole(supabase, meeting.org_id, user.id))) return fail("forbidden", 403);

  const body = (await request.json().catch(() => null)) as { answers?: unknown; stats?: unknown } | null;
  const answers = parseTaskAnswers(body?.answers);
  const stats = parseEndStats(body?.stats, answers);
  const deadlineAt = new Date(Date.now() + END_BUDGET_MS);
  // The answers go in the claim's own update: they and `ending` are stored together or not at all.
  const claim = await claimEnd(meeting.id, { taskAnswers: answers });
  if (claim === "not_found") return fail("not_found", 404);
  if (claim === "claimed") {
    if (stats) {
      after(() =>
        logEvent(meeting.id, "end_tasks", { ...stats }).catch((e) => console.warn(`end ${meeting.id}: end_tasks not logged: ${(e as Error).message}`)),
      );
    }
    after(() =>
      finishMeeting(meeting.id, { deadlineAt })
        .then((r) => {
          if (r !== "done") console.warn(`end ${meeting.id}: final pass ${r}; the cron retries`);
        })
        .catch((e) => console.error(`end ${meeting.id}: final pass failed: ${(e as Error).message}`)),
    );
  }
  // Already ending elsewhere: the answers still count while that final pass hasn't started; else
  // the page says they were not saved (never dropped silently).
  const late = claim === "noop" && answers.length ? ((await saveLateTaskAnswers(meeting.id, answers)) ? "saved" : "not_saved") : null;
  return NextResponse.json(
    { result: claim === "claimed" ? "ending" : "noop", ...(late ? { answers: late } : {}) },
    { headers: noStore },
  );
}
