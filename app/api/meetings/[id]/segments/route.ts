import { after, NextResponse, type NextRequest } from "next/server";
import { isUuid } from "@/lib/db/ids";
import { maybeTick } from "@/lib/meetings/tick";
import { IngestError, ingestSegments } from "@/lib/segments/ingest";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
// A notes tick (Claude + Docs) may run after the response, in after().
export const maxDuration = 300;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: noStore });

/**
 * Body: `{ segments: SegmentIn[], merges?: MergeIn[] }`. Only the meeting's starter. All
 * validation is in ingestSegments; resending a batch is safe (stored once).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("unauthenticated", 401);
  if (!isUuid(id)) return fail("not_found", 404);

  const { data: meeting, error } = await supabase
    .from("meetings")
    .select("id, started_by")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`segments: meeting: ${error.message}`);
  if (!meeting) return fail("not_found", 404);
  if (meeting.started_by !== user.id) return fail("not_starter", 403);

  const body = (await request.json().catch(() => null)) as { segments?: unknown; merges?: unknown } | null;
  if (!body || typeof body !== "object") return fail("bad_request", 400);

  try {
    const result = await ingestSegments(meeting.id, body.segments, body.merges);
    // Due notes tick after the response; maybeTick never throws.
    after(() => maybeTick(meeting.id));
    return NextResponse.json(result, { headers: noStore });
  } catch (e) {
    if (e instanceof IngestError) return fail(e.code, e.status);
    throw e;
  }
}
