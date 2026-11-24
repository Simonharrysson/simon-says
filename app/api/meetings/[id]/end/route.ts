import { NextResponse, type NextRequest } from "next/server";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { endMeeting } from "@/lib/meetings/tick";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
// The final notes pass (Claude + Docs) runs inside this request.
export const maxDuration = 300;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: noStore });

/**
 * End a meeting: close its ElevenLabs sessions, run the final notes pass, header
 * `Avslutat HH:mm`, status done. The starter or an org admin. Works under KILL_SWITCH (no
 * Claude then). Ending an ended meeting is a no-op: `{ result: "noop" }`.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    .select("id, org_id, started_by")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`end: meeting: ${error.message}`);
  if (!meeting) return fail("not_found", 404);
  if (meeting.started_by !== user.id && (await myRole(supabase, meeting.org_id)) !== "admin") {
    return fail("forbidden", 403);
  }

  const result = await endMeeting(meeting.id);
  if (result === "not_found") return fail("not_found", 404);
  return NextResponse.json({ result }, { headers: noStore });
}
