import { NextResponse, type NextRequest } from "next/server";
import { logEvent } from "@/lib/db/events";
import { isUuid } from "@/lib/db/ids";
import { updateOrgSettings } from "@/lib/db/orgs";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: noStore });

/**
 * The Avsluta dialog's "Fråga inte igen i den här föreningen" and its Ångra: sets
 * orgs.require_task_fields (as in Inställningar). Body: `{ on: boolean, meetingId?: uuid }`.
 * Admins only (RLS orgs_update: a member's update changes no row → 403). With `meetingId` (a
 * meeting of this förening) it is logged as meeting_events 'task_setting' `{ on, from }`, best
 * effort, so the numbers show how often the question is turned off from the dialog.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("unauthenticated", 401);
  if (!isUuid(id)) return fail("not_found", 404);
  const body = (await request.json().catch(() => null)) as { on?: unknown; meetingId?: unknown } | null;
  if (typeof body?.on !== "boolean") return fail("invalid", 400);
  const on = body.on;

  if (!(await updateOrgSettings(supabase, id, { require_task_fields: on }))) return fail("forbidden", 403);

  if (typeof body.meetingId === "string" && isUuid(body.meetingId)) {
    // As the user: RLS shows only this förening's meetings to its members.
    const { data: meeting } = await supabase.from("meetings").select("id").eq("id", body.meetingId).eq("org_id", id).maybeSingle();
    if (meeting) {
      await logEvent(meeting.id, "task_setting", { on, from: "end_dialog" }).catch((e) =>
        console.warn(`task-fields ${id}: not logged: ${(e as Error).message}`),
      );
    }
  }
  return NextResponse.json({ on }, { headers: noStore });
}
