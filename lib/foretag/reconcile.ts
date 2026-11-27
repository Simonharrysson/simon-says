import "server-only";
import { after } from "next/server";
import { unshareWith } from "@/lib/docs/create";
import { getGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { holdCrossingTasks } from "./summary";

// After the tree, a role or the membership of a Företag changed (0050): whoever can no longer see a
// meeting loses the Doc access Simon Says gave them, and tasks whose owner can no longer see their
// meeting are held for approval again. Idempotent and best effort: every failure is logged (ids
// only) and the next change runs it again. Shares are taken away through the starter's own grant,
// the only one that may change a Doc Simon Says created.

/** How far back tasks are re-checked when people move. */
const HANDOFF_WINDOW_DAYS = 90;

export interface ReconcileResult {
  revoked: number;
  failed: number;
  checkedMeetings: number;
}

export async function reconcileForetag(orgId: string): Promise<ReconcileResult> {
  const db = supabaseAdmin();
  const result: ReconcileResult = { revoked: 0, failed: 0, checkedMeetings: 0 };
  const { data: org, error: oe } = await db.from("orgs").select("kind").eq("id", orgId).maybeSingle();
  if (oe) throw new Error(`reconcile: org: ${oe.message}`);
  if ((org as { kind?: string } | null)?.kind !== "foretag") return result;

  const { data: meetings, error: me } = await db.from("meetings").select("id, doc_id, started_by, status, started_at").eq("org_id", orgId);
  if (me) throw new Error(`reconcile: meetings: ${me.message}`);
  const rows = (meetings ?? []) as { id: string; doc_id: string | null; started_by: string | null; status: string; started_at: string }[];
  const ids = rows.map((m) => m.id);
  const { data: shares, error: se } = ids.length
    ? await db.from("meeting_doc_shares").select("meeting_id, user_id").in("meeting_id", ids)
    : { data: [], error: null };
  if (se) throw new Error(`reconcile: shares: ${se.message}`);

  const byMeeting = new Map<string, string[]>();
  for (const s of (shares ?? []) as { meeting_id: string; user_id: string }[]) byMeeting.set(s.meeting_id, [...(byMeeting.get(s.meeting_id) ?? []), s.user_id]);

  const emails = new Map<string, string | null>();
  const emailOf = async (userId: string) => {
    if (!emails.has(userId)) {
      const { data } = await db.auth.admin.getUserById(userId);
      emails.set(userId, data.user?.email ?? null);
    }
    return emails.get(userId) ?? null;
  };

  for (const m of rows) {
    const shared = byMeeting.get(m.id);
    if (!shared?.length || !m.doc_id || !m.started_by) continue;
    result.checkedMeetings++;
    const { data: viewers, error: ve } = await db.rpc("foretag_viewer_ids", { p_meeting_id: m.id });
    if (ve) {
      console.error(`reconcile ${m.id}: viewers: ${ve.message}`);
      result.failed++;
      continue;
    }
    const can = new Set((viewers ?? []) as string[]);
    const gone = shared.filter((u) => !can.has(u) && u !== m.started_by);
    if (!gone.length) continue;
    let auth;
    try {
      auth = await getGoogleAuth(m.started_by);
    } catch (err) {
      console.error(`reconcile ${m.id}: starter's Google grant unavailable${err instanceof GoogleAuthLostError ? " (lost)" : ""}`);
      result.failed += gone.length;
      continue;
    }
    for (const userId of gone) {
      try {
        const email = await emailOf(userId);
        if (email) await unshareWith(auth, m.doc_id, email);
        const { error } = await db.from("meeting_doc_shares").delete().eq("meeting_id", m.id).eq("user_id", userId);
        if (error) throw new Error(error.message);
        result.revoked++;
      } catch (err) {
        console.error(`reconcile ${m.id}: unshare failed: ${(err as Error).message}`);
        result.failed++;
      }
    }
  }

  // Tasks of recent meetings whose owner can no longer see them wait for approval again.
  const since = Date.now() - HANDOFF_WINDOW_DAYS * 86_400_000;
  for (const m of rows) if (m.status === "done" && Date.parse(m.started_at) >= since) await holdCrossingTasks(m.id);
  console.info(`reconcile ${orgId}: revoked ${result.revoked}, failed ${result.failed}, meetings ${result.checkedMeetings}`);
  return result;
}

/** For server actions: run after the response, never failing the action. */
export function reconcileLater(orgId: string): Promise<void> {
  return reconcileForetag(orgId).then(
    () => undefined,
    (err: Error) => console.error(`reconcile ${orgId}: ${err.message}`),
  );
}

/** Schedules reconcileForetag after the response (a server action); outside a request it does nothing. */
export function reconcileAfter(orgId: string): void {
  try {
    after(() => reconcileLater(orgId));
  } catch {
    // Not in a request (a unit test calling the action): nothing to schedule.
  }
}
