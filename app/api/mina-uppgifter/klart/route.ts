import { NextResponse, type NextRequest } from "next/server";
import { completeNoteTask, setPrivatTaskDone } from "@/lib/home/complete";
import { setHandoffDone } from "@/lib/db/foretag";
import { isUuid } from "@/lib/db/ids";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: noStore });

/**
 * Mark a task done from Mina uppgifter or a meeting page (lib/home/complete.ts). Body
 * `{ kind: "note", meetingId, itemId }` (a förening task: its owner or an admin; the Doc gets
 * "✓ klart" where the line is still ours), `{ kind: "privat", taskId, done? }` or `{ kind: "handoff",
 * handoffId, done? }` (a reviewed Företag task, 0050). Answers
 * `{ ok: true, doc: "written" | "locked" | "none" | "failed" }`. Sent with `keepalive`, so a tick
 * whose undo time runs out as the page closes still arrives.
 */
export async function POST(request: NextRequest) {
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return fail("unauthenticated", 401);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  let result;
  if (body?.kind === "note" && typeof body.meetingId === "string" && typeof body.itemId === "string") {
    result = await completeNoteTask(db, user.id, body.meetingId, body.itemId);
  } else if (body?.kind === "handoff" && typeof body.handoffId === "string" && isUuid(body.handoffId)) {
    // A reviewed Företag task (0050): only its owner; no Doc is touched (they can't see it).
    const ok = await setHandoffDone(db, body.handoffId, body.done !== false);
    if (!ok) return fail("forbidden", 403);
    return NextResponse.json({ ok: true, doc: "none" }, { headers: noStore });
  } else if (body?.kind === "privat" && typeof body.taskId === "string") {
    result = await setPrivatTaskDone(db, body.taskId, body.done !== false);
  } else {
    return fail("bad_request", 400);
  }
  if (!result.ok) return fail(result.error, result.error === "forbidden" ? 403 : result.error === "not_open" ? 409 : 404);
  return NextResponse.json(result, { headers: noStore });
}
