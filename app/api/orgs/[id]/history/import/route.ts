import { NextResponse, type NextRequest } from "next/server";
import { DRIVE_ID } from "@/lib/agenda/candidates";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { getGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { extractProtocol } from "@/lib/history/extract";
import { MAX_DOC_CHARS } from "@/lib/history/extract-prompt";
import { IMPORT_RATE_LIMITED } from "@/lib/history/limits";
import { fileCreatedDate, googleStatus, readProtocolDoc } from "@/lib/history/read-doc";
import { saveImportedProtocol } from "@/lib/history/store";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
// One Doc read and one Claude call (≈ 5–30 s).
export const maxDuration = 120;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) => NextResponse.json({ error, message }, { status, headers: noStore });

/**
 * Imports ONE picked protocol (the browser loops over the picked Docs, so the admin sees
 * progress and every request stays short). Admins only, at most 60 per förening per 24 h
 * (claim_history_import). Reads the Doc with the admin's grant, sends its text to Claude (the
 * admin confirmed that), stores only the cleaned items (save_history_protocol): never the text
 * or the title. Logs only counts. Body `{ docId }` → `{ date, dateFrom, decisions, tasks, reports }`.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return fail("unauthenticated", 401, "Du är inte inloggad. Logga in och försök igen.");
  if (!isUuid(id)) return fail("not_found", 404, "Föreningen finns inte.");
  const role = await myRole(db, id);
  if (!role) return fail("not_found", 404, "Föreningen finns inte.");
  if (role !== "admin") return fail("forbidden", 403, "Bara administratörer kan läsa in gamla protokoll.");

  const body = (await request.json().catch(() => null)) as { docId?: unknown } | null;
  const docId = body?.docId;
  if (typeof docId !== "string" || !DRIVE_ID.test(docId)) return fail("bad_request", 400, "Välj ett protokoll.");

  const { data: people, error: peopleError } = await db.from("people").select("name").eq("org_id", id);
  if (peopleError) {
    console.error(`history/import: people: ${peopleError.message}`.slice(0, 200));
    return fail("error", 500, "Något gick fel. Försök igen om en liten stund.");
  }
  const names = ((people ?? []) as { name: string }[]).map((p) => p.name);

  let auth;
  let doc: { title: string; text: string };
  try {
    auth = await getGoogleAuth(user.id);
    doc = await readProtocolDoc(auth, docId);
  } catch (err) {
    if (err instanceof GoogleAuthLostError) return fail("google_auth_lost", 401, "Kopplingen till ditt Google-konto har gått ut. Logga ut och in igen.");
    const status = googleStatus(err);
    if (status === 403 || status === 404) return fail("doc_unreadable", 403, "Simon Says kan inte läsa dokumentet. Välj det igen i Google-väljaren.");
    console.error(`history/import: doc: ${(err as Error).message}`.slice(0, 200));
    return fail("google_unavailable", 502, "Vi nådde inte Google just nu. Försök igen om en liten stund.");
  }
  if (!doc.text.trim()) return fail("empty", 422, "Dokumentet är tomt.");
  if (doc.text.length > MAX_DOC_CHARS) return fail("too_long", 422, "Dokumentet är för långt för att vara ett protokoll och lästes inte in.");

  // At most 60 protocols per förening per 24 h: the daily Claude cap is shared by every förening's live notes.
  const { data: allowed, error: claimError } = await db.rpc("claim_history_import", { p_org_id: id });
  if (claimError) {
    if (claimError.code === "42501") return fail("forbidden", 403, "Bara administratörer kan läsa in gamla protokoll.");
    console.error(`history/import: claim: ${claimError.message}`.slice(0, 200));
    return fail("error", 500, "Något gick fel. Försök igen om en liten stund.");
  }
  if (allowed !== true) return fail("rate_limited", 429, IMPORT_RATE_LIMITED);

  const res = await extractProtocol({ orgId: id, title: doc.title, text: doc.text, people: names });
  if (!res.ok) {
    if (res.error === "spend") return fail("spend", 503, "Simon Says kan inte läsa protokoll just nu. Försök igen i morgon.");
    return fail(res.error, 502, "Simon Says kunde inte läsa protokollet. Försök igen.");
  }

  let date = res.protocol.date;
  let dateFrom: "doc" | "file" = "doc";
  if (!date) {
    dateFrom = "file";
    try {
      date = await fileCreatedDate(auth, docId);
    } catch (err) {
      console.error(`history/import: created: ${(err as Error).message}`.slice(0, 200));
    }
  }
  if (!date) return fail("no_date", 422, "Simon Says hittade inget datum i protokollet. Skriv datumet i dokumentet och försök igen.");

  const saved = await saveImportedProtocol(db, { orgId: id, driveFileId: docId, date, dateFrom, items: res.protocol.items });
  if (!saved.ok) {
    if (saved.code === "42501") return fail("forbidden", 403, "Bara administratörer kan läsa in gamla protokoll.");
    console.error(`history/import: save: ${saved.message}`.slice(0, 200));
    return fail("save_failed", 500, "Protokollet kunde inte sparas. Försök igen.");
  }
  const count = (k: string) => res.protocol.items.filter((i) => i.kind === k).length;
  console.info(`history/import: ${res.protocol.items.length} items, date from ${dateFrom}`);
  return NextResponse.json({ date, dateFrom, decisions: count("decision"), tasks: count("task"), reports: count("report") }, { headers: noStore });
}
