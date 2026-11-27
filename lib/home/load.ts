import "server-only";
import { hasTree } from "@/lib/foretag/tree";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ItemRole } from "@/lib/db/types";
import { docUrl } from "@/lib/ui/meetings";
import {
  countsMeeting,
  meetingCounts,
  myForeningTasks,
  myHandoffTasks,
  myPrivatTasks,
  pendingHandoffs,
  sortTasks,
  type HandoffRow,
  type HomeMeeting,
  type HomeNoteRow,
  type HomePerson,
  type HomeSpace,
  type MyTask,
  type PendingHandoff,
  type PrivatTaskRow,
  type RecentMeeting,
} from "./tasks";

// What the home page (/hem) reads, all with the user's own client: RLS returns only the spaces the
// user is a member of and what is in them, so the page can never show more than membership does.

/** Meetings read per förening (newest first): enough for a year of weekly meetings. */
export const MEETINGS_PER_SPACE = 60;
/** "Senaste mötena" on the home page. */
export const RECENT_MEETINGS = 6;

const fail = (what: string, error: { message: string }): never => {
  throw new Error(`loadHome: ${what}: ${error.message}`);
};

async function chunked<T>(ids: string[], read: (part: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, what: string): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await read(ids.slice(i, i + 100));
    if (error) fail(what, error);
    out.push(...(data ?? []));
  }
  return out;
}

const KIND_ORDER = { forening: 0, foretag: 1, privat: 2 } as const;

export interface HomeData {
  spaces: HomeSpace[];
  tasks: MyTask[];
  /** The user's own tasks (so every one may be ticked by them), sorted (sortTasks). */
  recent: RecentMeeting[];
  /** The user is in no förening and has never recorded in Privat. */
  brandNew: boolean;
  /** Föreningar where no one in the people list is linked to the user: their tasks can't be found. */
  unlinked: { id: string; name: string }[];
  /** The Doc of each förening meeting a task came from (for "Öppna dokumentet"). */
  docs: Record<string, string>;
  /** Företag (0050): tasks for people who can't see their meeting, waiting for this user's approval. */
  approvals: PendingHandoff[];
}

export async function loadHome(db: SupabaseClient, userId: string): Promise<HomeData> {
  const { data: memberships, error: e1 } = await db.from("org_members").select("org_id, role").eq("user_id", userId);
  if (e1) fail("members", e1);
  const roleOf = new Map((memberships ?? []).map((m) => [m.org_id as string, m.role as string]));
  const orgIds = [...roleOf.keys()];
  if (!orgIds.length) return { spaces: [], tasks: [], recent: [], brandNew: true, unlinked: [], docs: {}, approvals: [] };

  // `*`: groups_enabled (0054) is read where the database has it.
  const { data: orgs, error: e2 } = await db.from("orgs").select("*").in("id", orgIds);
  if (e2) fail("orgs", e2);
  const spaces: HomeSpace[] = ((orgs ?? []) as { id: string; name: string; kind: string; groups_enabled?: boolean }[])
    .map((o) => ({
      id: o.id,
      name: o.name,
      kind: o.kind === "privat" ? ("privat" as const) : o.kind === "foretag" ? ("foretag" as const) : ("forening" as const),
      isAdmin: roleOf.get(o.id) === "admin",
      tree: hasTree(o),
    }))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "sv") : KIND_ORDER[a.kind] - KIND_ORDER[b.kind]));
  // Föreningar and Företag share the note-row path (RLS narrows a Företag to what the user may see).
  const foreningIds = spaces.filter((s) => s.kind === "forening" || s.kind === "foretag").map((s) => s.id);
  // Handoffs (0050, 0054) exist only where the tree is or was on: a Företag, a förening with groups.
  // A förening that turned groups off keeps its approved ones; a plain förening reads none.
  const foretagIds = spaces.filter((s) => s.tree).map((s) => s.id);
  const privat = spaces.find((s) => s.kind === "privat") ?? null;

  // Finished meetings per space, newest first (a förening's `title` once 0048 is there: select *).
  const meetings: HomeMeeting[] = [];
  for (const space of spaces) {
    const { data, error } = await db
      .from("meetings")
      .select("*")
      .eq("org_id", space.id)
      .eq("status", "done")
      .eq("is_test", false)
      .order("started_at", { ascending: false })
      .limit(MEETINGS_PER_SPACE);
    if (error) fail("meetings", error);
    meetings.push(...((data ?? []) as HomeMeeting[]));
  }
  const foreningMeetings = meetings.filter((m) => foreningIds.includes(m.org_id));
  const privatMeetings = meetings.filter((m) => privat && m.org_id === privat.id && m.context_id);

  const [rows, people] = await Promise.all([
    chunked<HomeNoteRow>(
      foreningMeetings.map((m) => m.id),
      (part) => db.from("note_items").select("*").in("meeting_id", part).in("section", ["action", "decision"]),
      "note_items",
    ),
    foreningIds.length
      ? chunked<HomePerson>(foreningIds, (part) => db.from("people").select("id, org_id, name, role, member_user_id").in("org_id", part), "people")
      : Promise.resolve([] as HomePerson[]),
  ]);

  let privatTasks: MyTask[] = [];
  const privatCounts = new Map<string, { decisions: number; tasks: number }>();
  const contextNames = new Map<string, string>();
  if (privat) {
    const { data: contexts, error: e3 } = await db.from("contexts").select("id, name").eq("org_id", privat.id);
    if (e3) fail("contexts", e3);
    for (const c of contexts ?? []) contextNames.set(c.id as string, c.name as string);
    const taskRows = await chunked<PrivatTaskRow>(
      [...contextNames.keys()],
      (part) => db.from("context_tasks").select("id, context_id, meeting_id, text, owner, done, done_at, created_at, position").in("context_id", part),
      "context_tasks",
    );
    const { data: starts, error: e5 } = taskRows.length
      ? await db.from("meetings").select("id, started_at").eq("org_id", privat.id)
      : { data: [], error: null };
    if (e5) fail("privat meetings", e5);
    privatTasks = myPrivatTasks({ space: privat, tasks: taskRows, contexts: [...contextNames].map(([id, name]) => ({ id, name })), meetings: (starts ?? []) as HomeMeeting[] });
    const ids = privatMeetings.slice(0, RECENT_MEETINGS).map((m) => m.id);
    if (ids.length) {
      const { data: sums, error: e6 } = await db.from("private_summaries").select("meeting_id, decisions").in("meeting_id", ids);
      if (e6) fail("private_summaries", e6);
      for (const id of ids) {
        const s = (sums ?? []).find((x) => x.meeting_id === id);
        privatCounts.set(id, { decisions: (s?.decisions as string[] | undefined)?.length ?? 0, tasks: taskRows.filter((t) => t.meeting_id === id).length });
      }
    }
  }

  // Företag (0050): reviewed tasks from meetings the user can't see, and those waiting for their approval.
  const handoffs = foretagIds.length
    ? await chunked<HandoffRow>(
        foretagIds,
        (part) =>
          db
            .from("task_handoffs")
            .select("id, org_id, meeting_id, owner_person_id, text, due, due_date, from_name, status, done, created_at")
            .in("org_id", part)
            .in("status", ["pending", "approved"]),
        "task_handoffs",
      )
    : [];
  const tasks = sortTasks([
    ...myForeningTasks({ userId, spaces, meetings: foreningMeetings, rows, people }),
    ...myHandoffTasks({ userId, spaces, handoffs, people }),
    ...privatTasks,
  ]);
  const approvals = pendingHandoffs({ spaces, handoffs, people });

  const spaceOf = new Map(spaces.map((s) => [s.id, s]));
  const recent: RecentMeeting[] = [...foreningMeetings, ...privatMeetings]
    .filter(countsMeeting)
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .slice(0, RECENT_MEETINGS)
    .map((m) => {
      const space = spaceOf.get(m.org_id)!;
      const isPrivat = space.kind === "privat";
      const counts = isPrivat
        ? (privatCounts.get(m.id) ?? { decisions: 0, tasks: 0 })
        : meetingCounts(rows.filter((r) => r.meeting_id === m.id), (m.agenda_roles ?? {}) as Record<string, ItemRole>);
      const title = (typeof m.title === "string" && m.title.trim()) || (isPrivat && m.context_id ? (contextNames.get(m.context_id) ?? null) : null);
      return {
        id: m.id,
        spaceId: space.id,
        spaceName: space.name,
        spaceKind: space.kind,
        startedAt: m.started_at,
        title,
        ...counts,
        href: isPrivat ? `/privat/mote/${m.id}` : `/orgs/${space.id}/mote/${m.id}`,
      };
    });

  const brandNew = foreningIds.length === 0 && privatMeetings.length === 0 && privatTasks.length === 0;
  const unlinked = spaces
    .filter((s) => s.kind === "forening" && !people.some((p) => p.org_id === s.id && p.member_user_id === userId))
    .map((s) => ({ id: s.id, name: s.name }));
  const docs: Record<string, string> = {};
  for (const m of foreningMeetings) if (m.doc_id) docs[m.id] = docUrl(m.doc_id);
  return { spaces, tasks, recent, brandNew, unlinked, docs, approvals };
}
