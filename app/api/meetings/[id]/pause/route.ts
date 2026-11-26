import { NextResponse, type NextRequest } from "next/server";
import { logEvent } from "@/lib/db/events";
import { isUuid } from "@/lib/db/ids";
import { memberRole } from "@/lib/db/orgs";
import { canRunMeeting } from "@/lib/meetings/access";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: noStore });

/**
 * Log Paus / Fortsätt on the live page. Body `{ paused: boolean }`. The audio itself stops in
 * the browser; this only records it (meeting_events 'paused' / 'unpaused'). Any member.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("unauthenticated", 401);
  if (!isUuid(id)) return fail("not_found", 404);

  const { data: meeting, error } = await supabase.from("meetings").select("id, org_id, status").eq("id", id).maybeSingle();
  if (error) throw new Error(`pause: meeting: ${error.message}`);
  if (!meeting) return fail("not_found", 404);
  if (!canRunMeeting(await memberRole(supabase, meeting.org_id, user.id))) return fail("not_member", 403);
  if (meeting.status !== "live") return fail("not_live", 409);

  const body = (await request.json().catch(() => null)) as { paused?: unknown } | null;
  if (typeof body?.paused !== "boolean") return fail("bad_request", 400);
  await logEvent(meeting.id, body.paused ? "paused" : "unpaused");
  return NextResponse.json({ ok: true }, { headers: noStore });
}
