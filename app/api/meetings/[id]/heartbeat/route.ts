import { NextResponse, type NextRequest } from "next/server";
import { isUuid } from "@/lib/db/ids";
import { checkLimits } from "@/lib/limits";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: noStore });

/**
 * Starter's browser pings this; it only sets last_heartbeat_at. Answers `{ warn, stop }` from
 * checkLimits (also under the kill switch, where stop is true).
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("unauthenticated", 401);
  if (!isUuid(id)) return fail("not_found", 404);

  const { data: meeting, error } = await supabase
    .from("meetings")
    .select("id, org_id, started_by, status")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`heartbeat: meeting: ${error.message}`);
  if (!meeting) return fail("not_found", 404);
  if (meeting.started_by !== user.id) return fail("not_starter", 403);
  if (meeting.status === "done" || meeting.status === "abandoned") return fail("not_live", 409);

  const { error: ue } = await supabaseAdmin()
    .from("meetings")
    .update({ last_heartbeat_at: new Date().toISOString() })
    .eq("id", meeting.id);
  if (ue) throw new Error(`heartbeat: update: ${ue.message}`);

  const limits = await checkLimits(meeting.org_id, meeting.id);
  return NextResponse.json({ warn: limits.warn, stop: limits.stop }, { headers: noStore });
}
