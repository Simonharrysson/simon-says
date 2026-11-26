import { NextResponse, type NextRequest } from "next/server";
import { isUuid } from "@/lib/db/ids";
import { isMeetingType, PrepareBodySchema } from "@/lib/prepare/draft";
import { loadDraft, savePrepared } from "@/lib/prepare/prepare";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
// Creating the Doc, sharing it with the members and two more Google batches.
export const maxDuration = 120;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) => NextResponse.json({ error, message }, { status, headers: noStore });

async function signedIn() {
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  return { db, user };
}

/**
 * Förbered möte, the draft: `?typ=veckomote|styrelsemote|arsmote&datum=YYYY-MM-DD`. The format's
 * standing items, "Från förra veckan" with the previous meeting's open tasks, recurring topics as
 * unticked suggestions; an agenda already prepared for that date comes back to be edited. Members only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db, user } = await signedIn();
  if (!user) return fail("unauthenticated", 401, "Du är inte inloggad. Logga in och försök igen.");
  if (!isUuid(id)) return fail("not_found", 404, "Föreningen finns inte.");
  const type = request.nextUrl.searchParams.get("typ") ?? "veckomote";
  const date = request.nextUrl.searchParams.get("datum") ?? "";
  if (!isMeetingType(type)) return fail("bad_request", 400, "Mötestypen är ogiltig.");
  try {
    const res = await loadDraft(db, id, type, date);
    if (!res.ok) return fail(res.error, res.status, res.message);
    return NextResponse.json(res.draft, { headers: noStore });
  } catch (err) {
    console.error(`prepare: draft: ${(err as Error).message}`);
    return fail("draft_failed", 500, "Vi kunde inte ta fram dagordningen just nu. Försök igen om en liten stund.");
  }
}

/**
 * "Skapa dagordning": body `{ type, date, time?, items: [{ id, label, source, on, tasks? }] }`.
 * Creates the agenda Doc in the förening's meeting folder (shared with the members) or, preparing
 * again for the same date, edits it (only Simon Says' own lines; human edits win). Returns
 * `{ docUrl, docName, date, created, reordered }`.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db, user } = await signedIn();
  if (!user) return fail("unauthenticated", 401, "Du är inte inloggad. Logga in och försök igen.");
  if (!isUuid(id)) return fail("not_found", 404, "Föreningen finns inte.");
  const parsed = PrepareBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("bad_request", 400, "Dagordningen är ogiltig. Ladda om sidan och försök igen.");
  try {
    const res = await savePrepared(db, user, id, parsed.data);
    if (!res.ok) return fail(res.error, res.status, res.message);
    const { ok: _ok, ...body } = res;
    return NextResponse.json(body, { headers: noStore });
  } catch (err) {
    console.error(`prepare: save: ${(err as Error).message}`);
    return fail("save_failed", 500, "Dagordningen kunde inte sparas. Försök igen om en liten stund.");
  }
}
