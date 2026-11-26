import { NextResponse, type NextRequest } from "next/server";
import { isUuid } from "@/lib/db/ids";
import type { NoteItemRow } from "@/lib/db/types";
import { meetingTasks, taskMode } from "@/lib/notes/tasks";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: noStore });

/**
 * The live page's "Uppgifter" (concrete tasks): this meeting's own tasks with what each lacks,
 * and the förening's mode (`require`: the page asks, Avsluta asks to complete or dismiss).
 * Any member; RLS (note_items_select, orgs) hides other föreningar's meetings.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("unauthenticated", 401);
  if (!isUuid(id)) return fail("not_found", 404);
  const { data: meeting, error } = await supabase.from("meetings").select("id, org_id").eq("id", id).maybeSingle();
  if (error) throw new Error(`tasks: meeting: ${error.message}`);
  if (!meeting) return fail("not_found", 404);
  const [rows, org] = await Promise.all([
    supabase.from("note_items").select("*").eq("meeting_id", id),
    supabase.from("orgs").select("require_task_fields").eq("id", meeting.org_id).maybeSingle(),
  ]);
  if (rows.error) throw new Error(`tasks: rows: ${rows.error.message}`);
  if (org.error) throw new Error(`tasks: org: ${org.error.message}`);
  return NextResponse.json(
    { mode: taskMode(org.data as { require_task_fields?: boolean } | null), tasks: meetingTasks((rows.data ?? []) as NoteItemRow[]) },
    { headers: noStore },
  );
}
