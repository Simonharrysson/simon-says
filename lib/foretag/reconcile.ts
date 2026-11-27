import "server-only";
import { after } from "next/server";
import { recordDocShares } from "@/lib/docs/access";
import { revokeLegacyShare, revokePermission, shareWith } from "@/lib/docs/create";
import { getGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { holdCrossingTasks } from "./summary";

// After the tree, a role or the membership of a Företag changed (0050): whoever can no longer see a
// meeting loses the Doc access Simon Says gave them, and tasks whose owner can no longer see their
// meeting are held for approval again. Idempotent and best effort: every failure is logged (ids
// only) and the next change runs it again. Shares are taken away through the starter's own grant,
// the only one that may change a Doc Simon Says created. Only the permission Simon Says created is
// removed (its id, 0053), never a share the starter added by hand; a share to an address the
// account no longer has (e-mail changed) is removed too, and made again to the new address if
// they still see the meeting.

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
    ? await db.from("meeting_doc_shares").select("meeting_id, user_id, email, permission_id, preexisting").in("meeting_id", ids)
    : { data: [], error: null };
  if (se) throw new Error(`reconcile: shares: ${se.message}`);

  const byMeeting = new Map<string, ShareRow[]>();
  for (const s of (shares ?? []) as ShareRow[]) byMeeting.set(s.meeting_id, [...(byMeeting.get(s.meeting_id) ?? []), s]);

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
    const work: { share: ShareRow; current: string | null; reshare: boolean }[] = [];
    for (const share of shared) {
      if (share.user_id === m.started_by) continue;
      const current = await emailOf(share.user_id);
      const moved = Boolean(share.email && current && share.email.toLowerCase() !== current.toLowerCase());
      if (!can.has(share.user_id)) work.push({ share, current, reshare: false });
      else if (moved) work.push({ share, current, reshare: true });
    }
    if (!work.length) continue;
    let auth;
    try {
      auth = await getGoogleAuth(m.started_by);
    } catch (err) {
      console.error(`reconcile ${m.id}: starter's Google grant unavailable${err instanceof GoogleAuthLostError ? " (lost)" : ""}`);
      result.failed += work.length;
      continue;
    }
    for (const { share, current, reshare } of work) {
      try {
        await revokeShare(auth, m.doc_id, m.id, share);
        const { error } = await db.from("meeting_doc_shares").delete().eq("meeting_id", m.id).eq("user_id", share.user_id);
        if (error) throw new Error(error.message);
        result.revoked++;
        if (reshare && current) {
          const grant = await shareWith(auth, m.doc_id, current, { checkExisting: true });
          await recordDocShares(m.id, [share.user_id], { [share.user_id]: { ...grant, email: current } });
        }
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

interface ShareRow {
  meeting_id: string;
  user_id: string;
  /** 0053; null on older rows. */
  email: string | null;
  permission_id: string | null;
  preexisting: boolean | null;
}

/**
 * Takes away the access Simon Says gave: exactly its permission (0053). An address that had access
 * before we shared keeps it. A row from before 0053 (no id; a new Doc of ours, shared by us with
 * that address) removes the non-owner permission of the address it went to, never another.
 */
async function revokeShare(auth: Awaited<ReturnType<typeof getGoogleAuth>>, docId: string, meetingId: string, share: ShareRow): Promise<void> {
  if (share.preexisting) return;
  if (share.permission_id) return revokePermission(auth, docId, share.permission_id);
  // Before 0053: the address the share went to (0053 filled it in), never the account's later one.
  if (share.email) await revokeLegacyShare(auth, docId, share.email);
  else console.warn(`reconcile ${meetingId}: an old share without its address; Drive left alone`);
}

/** How many queued companies and revocations one cron run takes. */
const DRAIN_LIMIT = 20;
/** How long a cron run holds a queued company (longer than the cron's 300 s run). */
const LEASE_MS = 10 * 60_000;
/** A revocation that keeps failing is given up after this many tries (logged). */
const MAX_ATTEMPTS = 5;

/**
 * The 5-minute cron (0053): companies queued by changes made outside the app's actions (a person
 * relinked, an e-mail changed, an account deleted) are reconciled, and a deleted account's Drive
 * permissions are removed by id. Best effort; returns what it did.
 */
export async function drainForetagQueues(): Promise<{ orgs: number; revocations: number }> {
  const db = supabaseAdmin();
  const done = { orgs: 0, revocations: 0 };
  const free = `leased_until.is.null,leased_until.lt.${new Date().toISOString()}`;
  const { data: queued, error: qe } = await db.from("foretag_reconcile_queue").select("org_id, queued_at").or(free).order("queued_at").limit(DRAIN_LIMIT);
  if (qe) console.error(`reconcile queue: ${qe.message}`);
  for (const { org_id, queued_at } of (queued ?? []) as { org_id: string; queued_at: string }[]) {
    // Leased, not removed: a run that dies (a timeout) leaves it for the next cron once the lease
    // ends. Removed only after it succeeded, and only if no change queued it again meanwhile.
    const { data: claimed } = await db
      .from("foretag_reconcile_queue")
      .update({ leased_until: new Date(Date.now() + LEASE_MS).toISOString() })
      .eq("org_id", org_id)
      .eq("queued_at", queued_at)
      .or(free)
      .select("org_id");
    if (!claimed?.length) continue;
    try {
      await reconcileForetag(org_id);
      await db.from("foretag_reconcile_queue").delete().eq("org_id", org_id).eq("queued_at", queued_at);
      done.orgs++;
    } catch (err) {
      // The lease runs out and the next cron tries again.
      console.error(`reconcile ${org_id}: ${(err as Error).message}`);
    }
  }

  const { data: revocations, error: re } = await db.from("doc_share_revocations").select("id, doc_id, owner_user_id, permission_id, attempts").order("queued_at").limit(DRAIN_LIMIT);
  if (re) console.error(`revocation queue: ${re.message}`);
  for (const r of (revocations ?? []) as { id: string; doc_id: string; owner_user_id: string; permission_id: string; attempts: number }[]) {
    try {
      await revokePermission(await getGoogleAuth(r.owner_user_id), r.doc_id, r.permission_id);
      await db.from("doc_share_revocations").delete().eq("id", r.id);
      done.revocations++;
    } catch (err) {
      const lost = err instanceof GoogleAuthLostError;
      console.error(`revocation ${r.id}: ${lost ? "starter's Google grant lost" : (err as Error).message}`);
      if (lost || r.attempts + 1 >= MAX_ATTEMPTS) await db.from("doc_share_revocations").delete().eq("id", r.id);
      else await db.from("doc_share_revocations").update({ attempts: r.attempts + 1 }).eq("id", r.id);
    }
  }
  return done;
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
