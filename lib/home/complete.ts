import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OAuth2Client } from "google-auth-library";
import { isAgentTask } from "@/lib/agent/tasks";
import { propagateDone } from "@/lib/agenda/followup";
import type { ItemRole, NoteItemRow } from "@/lib/db/types";
import { isUuid } from "@/lib/db/ids";
import { readNotesTab, type NotesTab } from "@/lib/docs/notes";
import { getGoogleAuth } from "@/lib/google/client";
import { driveSubOf, orgDriveClient } from "@/lib/google/drive-account";
import { docsApi, writeWithRevisionGuard, type DocsRequest } from "@/lib/google/docs";
import { isCopy, isTask } from "@/lib/meetings/summary";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { planDocDone } from "./doc-done";
import { canTick, countsMeeting, isMine, myPersonIds, visible, type HomePerson } from "./tasks";

// Ticking a task done in the app (Mina uppgifter, the meeting page). Checked as the user (their
// own client: RLS shows only what membership allows), written by the server:
// - a förening task: only its owner (person link or role; for a task given to Claude, the meeting's
//   runner who assigned it) or an admin of the förening, only in a
//   finished real meeting (a live one is still written by its tick). The row and its tasks copies
//   are marked done, the done flows back up the "Från förra veckan" chain (propagateDone), and the
//   Doc gets "✓ klart" on every line that is still ours (human edit wins: an edited line is left
//   alone, and the page asks the person to tick it in the Doc as well);
// - a Privat task: the space's own member, through the same update as the Privat pages.

export type DocOutcome = "written" | "locked" | "none" | "failed";
export type CompleteResult = { ok: true; doc: DocOutcome } | { ok: false; error: "not_found" | "forbidden" | "not_open" };

export interface CompleteDeps {
  admin: () => SupabaseClient;
  getAuth: (userId: string) => Promise<OAuth2Client>;
  /** 0070: the förening's Drive account that made the Doc (default orgDriveClient). */
  getOrgAuth?: (orgId: string, driveAccountSub: string) => Promise<OAuth2Client>;
  readTab: (auth: OAuth2Client, docId: string, tabId: string) => Promise<NotesTab>;
  batchUpdate: (auth: OAuth2Client, docId: string, requests: DocsRequest[], revisionId: string) => Promise<void>;
}

const defaultDeps: CompleteDeps = {
  admin: supabaseAdmin,
  getAuth: getGoogleAuth,
  getOrgAuth: orgDriveClient,
  readTab: readNotesTab,
  batchUpdate: async (auth, docId, requests, revisionId) => {
    await docsApi(auth).documents.batchUpdate({ documentId: docId, requestBody: { requests, writeControl: { requiredRevisionId: revisionId } } });
  },
};

const chainOf = (r: NoteItemRow) => ({
  ...r,
  kind: r.kind ?? null,
  done: r.done ?? false,
  copy_of: r.copy_of ?? null,
  carried_from_meeting: r.carried_from_meeting ?? null,
  carried_from_id: r.carried_from_id ?? null,
});

/** Mark one förening task done (see above). `db` is the user's own client. */
export async function completeNoteTask(
  db: SupabaseClient,
  userId: string,
  meetingId: string,
  itemId: string,
  deps: CompleteDeps = defaultDeps,
): Promise<CompleteResult> {
  if (!isUuid(meetingId) || typeof itemId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(itemId)) return { ok: false, error: "not_found" };
  const { data: meeting, error: e1 } = await db
    .from("meetings")
    .select("id, org_id, status, is_test, doc_id, notes_tab_id, started_by, agenda_roles")
    .eq("id", meetingId)
    .maybeSingle();
  if (e1) throw new Error(`completeNoteTask: meeting: ${e1.message}`);
  if (!meeting) return { ok: false, error: "not_found" };
  const { data: org, error: e2 } = await db.from("orgs").select("id, kind").eq("id", meeting.org_id).maybeSingle();
  if (e2) throw new Error(`completeNoteTask: org: ${e2.message}`);
  if (!org || org.kind === "privat") return { ok: false, error: "not_found" };
  if (!countsMeeting(meeting)) return { ok: false, error: "not_open" };

  const [{ data: rows, error: e3 }, { data: member, error: e4 }, { data: people, error: e5 }] = await Promise.all([
    db.from("note_items").select("*").eq("meeting_id", meetingId),
    db.from("org_members").select("role").eq("org_id", meeting.org_id).eq("user_id", userId).maybeSingle(),
    db.from("people").select("id, org_id, name, role, member_user_id").eq("org_id", meeting.org_id),
  ]);
  if (e3 || e4 || e5) throw new Error(`completeNoteTask: ${(e3 ?? e4 ?? e5)!.message}`);
  if (!member) return { ok: false, error: "not_found" };
  const all = (rows ?? []) as NoteItemRow[];
  const row = all.find((r) => r.id === itemId);
  // The same rows the list shows: never one a human deleted, a Må-runda row or an info cell.
  if (!row || !isTask(chainOf(row)) || !visible(row, (meeting.agenda_roles ?? {}) as Record<string, ItemRole>)) return { ok: false, error: "not_found" };
  const orgPeople = (people ?? []) as HomePerson[];
  const mine = isMine(row, orgPeople, myPersonIds(orgPeople, meeting.org_id, userId));
  // A task the meeting gave Claude (lib/agent/tasks.ts): its assigner, the meeting's runner, stands in as owner.
  const assigner = meeting.started_by === userId && isAgentTask(row, orgPeople);
  if (!canTick({ mine: mine || assigner, isAdmin: member.role === "admin" })) return { ok: false, error: "forbidden" };

  const copies = all.filter((r) => isCopy(r) && (r.copy_of ?? r.id.slice(0, -2)) === row.id);
  const admin = deps.admin();
  const ids = [row.id, ...copies.map((c) => c.id)];
  const { error: e6 } = await admin.from("note_items").update({ done: true }).eq("meeting_id", meetingId).in("id", ids);
  if (e6) throw new Error(`completeNoteTask: update: ${e6.message}`);
  // The meetings it was carried from ("Från förra veckan") are closed too.
  await propagateDone([{ ...row, done: true }, ...copies.map((c) => ({ ...c, done: true }))], meeting.org_id, false, admin);
  // ...and the copies later meetings carried on (and theirs), so it doesn't come back as open.
  await propagateForward(meetingId, row.id, meeting.org_id, admin);

  const doc = await writeDone(meeting, [row, ...copies], deps).catch((err) => {
    console.error(`completeNoteTask: Doc not written: ${(err as Error).message}`);
    return "failed" as const;
  });
  return { ok: true, doc };
}

/** Carry hops followed forward (a guard; real chains are one per meeting). */
const MAX_FORWARD = 100;

/**
 * Mark done every later copy of a task ("Från förra veckan" in the next meeting, and the one after),
 * with their tasks copies; only meetings of the same förening that are not Testmöten.
 */
export async function propagateForward(meetingId: string, itemId: string, orgId: string, admin: SupabaseClient): Promise<number> {
  let level: { meeting: string; id: string }[] = [{ meeting: meetingId, id: itemId }];
  const seen = new Set<string>([`${meetingId}\u0000${itemId}`]);
  let updated = 0;
  for (let depth = 0; level.length && depth < MAX_FORWARD; depth++) {
    const next: { meeting: string; id: string }[] = [];
    for (const src of level) {
      const { data, error } = await admin
        .from("note_items")
        .select("meeting_id, id, meetings!inner(org_id, is_test)")
        .eq("carried_from_meeting", src.meeting)
        .eq("carried_from_id", src.id)
        .eq("meetings.org_id", orgId)
        .eq("meetings.is_test", false);
      if (error) throw new Error(`propagateForward: ${error.message}`);
      for (const r of (data ?? []) as { meeting_id: string; id: string }[]) {
        const k = `${r.meeting_id}\u0000${r.id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        next.push({ meeting: r.meeting_id, id: r.id });
      }
    }
    for (const r of next) {
      // The row and its tasks copies (`<id>-t`, or copy_of = id): two plain filters, no or-string.
      for (const q of [
        admin.from("note_items").update({ done: true }).eq("meeting_id", r.meeting).in("id", [r.id, `${r.id}-t`]).eq("done", false).select("id"),
        admin.from("note_items").update({ done: true }).eq("meeting_id", r.meeting).eq("copy_of", r.id).eq("done", false).select("id"),
      ]) {
        const { data, error } = await q;
        if (error) throw new Error(`propagateForward: ${error.message}`);
        updated += data?.length ?? 0;
      }
    }
    level = next;
  }
  return updated;
}

async function writeDone(
  meeting: { id: string; org_id: string; doc_id: string | null; notes_tab_id: string | null; started_by: string | null },
  targets: NoteItemRow[],
  deps: CompleteDeps,
): Promise<DocOutcome> {
  if (!meeting.doc_id || !meeting.notes_tab_id) return "none";
  // Never rendered (no line of ours in the Doc): the person ticks it there.
  if (!targets[0].range_name) return "locked";
  // The grant that made the Doc, like the tick: the förening's Drive account (0070), else the starter's.
  const orgSub = await driveSubOf("meetings", meeting.id, deps.admin());
  if (!meeting.started_by && !orgSub) return "failed";
  const auth = orgSub ? await (deps.getOrgAuth ?? orgDriveClient)(meeting.org_id, orgSub) : await deps.getAuth(meeting.started_by!);
  const docId = meeting.doc_id;
  const tabId = meeting.notes_tab_id;
  const { value: plan } = await writeWithRevisionGuard(
    () => deps.readTab(auth, docId, tabId),
    async (tab) => {
      const p = planDocDone(tab, tabId, targets);
      if (p.requests.length) await deps.batchUpdate(auth, docId, p.requests, tab.revisionId);
      return p;
    },
  );
  // What we wrote is ours: the next read must not take it for a human's edit.
  for (const w of plan.written) {
    const { error } = await deps.admin().from("note_items").update({ last_rendered_text: w.text }).eq("meeting_id", meeting.id).eq("id", w.id);
    if (error) throw new Error(`completeNoteTask: last_rendered_text: ${error.message}`);
  }
  return plan.primaryDone ? "written" : "locked";
}

/** Mark one Privat task done (or open again), as the user: RLS keeps it to their own space. */
export async function setPrivatTaskDone(db: SupabaseClient, taskId: string, done: boolean): Promise<CompleteResult> {
  if (!isUuid(taskId)) return { ok: false, error: "not_found" };
  const { data, error } = await db
    .from("context_tasks")
    .update({ done, done_at: done ? new Date().toISOString() : null })
    .eq("id", taskId)
    .select("id");
  if (error) throw new Error(`setPrivatTaskDone: ${error.message}`);
  return data?.length ? { ok: true, doc: "none" } : { ok: false, error: "not_found" };
}
