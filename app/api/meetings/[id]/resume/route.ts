import { NextResponse, type NextRequest } from "next/server";
import { isUuid } from "@/lib/db/ids";
import { resumeMeeting, type ResumeResult } from "@/lib/meetings/resume";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: noStore });

const refusal: Partial<Record<ResumeResult, [number, string]>> = {
  not_found: [404, "not_found"],
  too_old: [409, "too_old"],
  not_resumable: [409, "not_resumable"],
  org_busy: [409, "org_busy"],
};

/**
 * "Fortsätt mötet": the starter continues an unfinished meeting. Live → nothing to do
 * (`{ result: "live" }`); abandoned < 2 h ago → back to live (`{ result: "resumed" }`).
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
  const { data: meeting, error } = await supabase.from("meetings").select("id, started_by").eq("id", id).maybeSingle();
  if (error) throw new Error(`resume: meeting: ${error.message}`);
  if (!meeting) return fail("not_found", 404);
  if (meeting.started_by !== user.id) return fail("not_starter", 403);

  const result = await resumeMeeting(meeting.id);
  const refused = refusal[result];
  if (refused) return fail(refused[1], refused[0]);
  return NextResponse.json({ result }, { headers: noStore });
}
