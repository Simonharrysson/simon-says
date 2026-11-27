import { NextResponse, type NextRequest } from "next/server";
import { isUuid } from "@/lib/db/ids";
import { approveHandoff, dropHandoff } from "@/lib/db/foretag";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: noStore });

/**
 * "Väntar på godkännande" (Företag, 0050): approve a held task (with the reviewed wording) or drop
 * it. Body `{ id, action: "approve", text }` or `{ id, action: "drop" }`. The database decides who
 * may (the meeting's starter or an admin who can see it); anything else is 403.
 */
export async function POST(request: NextRequest) {
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return fail("unauthenticated", 401);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const id = typeof body?.id === "string" && isUuid(body.id) ? body.id : null;
  if (!id) return fail("bad_request", 400);
  if (body?.action === "approve") {
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text.length < 1 || text.length > 500) return fail("bad_text", 400);
    return (await approveHandoff(db, id, text)) ? NextResponse.json({ ok: true }, { headers: noStore }) : fail("forbidden", 403);
  }
  if (body?.action === "drop") {
    return (await dropHandoff(db, id)) ? NextResponse.json({ ok: true }, { headers: noStore }) : fail("forbidden", 403);
  }
  return fail("bad_request", 400);
}
