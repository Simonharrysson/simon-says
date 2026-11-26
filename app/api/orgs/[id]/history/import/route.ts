import { NextResponse, type NextRequest } from "next/server";
import { DRIVE_ID } from "@/lib/agenda/candidates";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { getGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { MANY_MEETINGS_MESSAGE } from "@/lib/history/doc-text";
import { extractProtocol } from "@/lib/history/extract";
import { MAX_DOC_CHARS, validDate } from "@/lib/history/extract-prompt";
import { IMPORT_RATE_LIMITED, OWN_DOC_MESSAGE } from "@/lib/history/limits";
import { fileCreatedDate, googleStatus, readProtocolDoc } from "@/lib/history/read-doc";
import { ownDocIds, saveImportedProtocol } from "@/lib/history/store";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
// One Doc read and ONE Claude call (one meeting); the extraction itself times out at 110 s.
export const maxDuration = 180;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) => NextResponse.json({ error, message }, { status, headers: noStore });

/**
 * Imports ONE meeting of a picked Doc: `{ docId, section, sections }` (a Doc can hold several
 * meetings, see lib/history/doc-text.ts; the browser loops over every section the estimate
 * found, so the admin sees progress and every request is one Claude call). Admins only, at most
 * 60 per förening per 24 h (claim_history_import; the claim is given back when Claude was never
 * called). Simon Says' own Docs are refused. Sends the section's text to Claude (the admin
 * confirmed that), stores only the cleaned items: never the text or the title. Logs only counts.
 * → `{ protocolId, date, dateFrom, decisions, tasks, reports }`.
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

  const body = (await request.json().catch(() => null)) as { docId?: unknown; section?: unknown; sections?: unknown } | null;
  const docId = body?.docId;
  const section = body?.section ?? 0;
  const sections = body?.sections ?? 1;
  if (
    typeof docId !== "string" ||
    !DRIVE_ID.test(docId) ||
    !Number.isInteger(section) ||
    !Number.isInteger(sections) ||
    (section as number) < 0 ||
    (section as number) >= (sections as number) ||
    (sections as number) > 60
  ) {
    return fail("bad_request", 400, "Välj ett protokoll.");
  }
  const sec = section as number;
  const secs = sections as number;

  let names: string[];
  try {
    if ((await ownDocIds(db, id, [docId])).size) return fail("own_doc", 422, OWN_DOC_MESSAGE);
    const { data: people, error: peopleError } = await db.from("people").select("name").eq("org_id", id);
    if (peopleError) throw new Error(peopleError.message);
    names = ((people ?? []) as { name: string }[]).map((p) => p.name);
  } catch (err) {
    console.error(`history/import: ${(err as Error).message}`.slice(0, 200));
    return fail("error", 500, "Något gick fel. Försök igen om en liten stund.");
  }

  let auth;
  let doc: Awaited<ReturnType<typeof readProtocolDoc>>;
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
  if (!doc.split.ok) {
    if (doc.split.reason === "empty") return fail("empty", 422, "Dokumentet är tomt.");
    return fail("many_meetings", 422, MANY_MEETINGS_MESSAGE);
  }
  // The split is deterministic: a different count means the Doc changed since the estimate.
  if (doc.split.sections.length !== secs) return fail("doc_changed", 409, "Dokumentet har ändrats sedan du valde det. Välj det igen.");
  const part = doc.split.sections[sec];
  if (part.text.length > MAX_DOC_CHARS) return fail("too_long", 422, "Mötet är för långt för att vara ett protokoll och lästes inte in.");

  // At most 60 per förening per 24 h: the daily Claude cap is shared by every förening's live notes.
  const { data: claimId, error: claimError } = await db.rpc("claim_history_import", { p_org_id: id });
  if (claimError) {
    if (claimError.code === "42501") return fail("forbidden", 403, "Bara administratörer kan läsa in gamla protokoll.");
    console.error(`history/import: claim: ${claimError.message}`.slice(0, 200));
    return fail("error", 500, "Något gick fel. Försök igen om en liten stund.");
  }
  if (claimId === null || claimId === undefined) return fail("rate_limited", 429, IMPORT_RATE_LIMITED);

  const res = await extractProtocol({ orgId: id, title: part.title, text: part.text, people: names });
  if (!res.ok) {
    // No answer and no usage: Claude was never called (spend gate) or the request failed: give the claim back.
    if (res.usage === null) {
      const { error } = await db.rpc("release_history_import", { p_org_id: id, p_claim_id: claimId });
      if (error) console.error(`history/import: release: ${error.message}`.slice(0, 200));
    }
    if (res.error === "spend") return fail("spend", 503, "Simon Says kan inte läsa protokoll just nu. Försök igen i morgon.");
    return fail(res.error, 502, "Simon Says kunde inte läsa protokollet. Försök igen.");
  }

  // The date: what Claude read, else the section's dated heading, else the Doc's creation date.
  let date = res.protocol.date ?? validDate(part.date);
  let dateFrom: "doc" | "file" = "doc";
  if (!date) {
    dateFrom = "file";
    try {
      date = validDate(await fileCreatedDate(auth, docId));
    } catch (err) {
      console.error(`history/import: created: ${(err as Error).message}`.slice(0, 200));
    }
  }
  if (!date) return fail("no_date", 422, "Simon Says hittade inget datum i protokollet. Skriv datumet i dokumentet och försök igen.");

  const saved = await saveImportedProtocol(db, { orgId: id, driveFileId: docId, section: sec, sections: secs, date, dateFrom, items: res.protocol.items });
  if (!saved.ok) {
    if (saved.code === "42501") return fail("forbidden", 403, "Bara administratörer kan läsa in gamla protokoll.");
    console.error(`history/import: save: ${saved.message}`.slice(0, 200));
    return fail("save_failed", 500, "Protokollet kunde inte sparas. Försök igen.");
  }
  const count = (k: string) => res.protocol.items.filter((i) => i.kind === k).length;
  console.info(`history/import: section ${sec + 1}/${secs}, ${res.protocol.items.length} items, date from ${dateFrom}`);
  return NextResponse.json(
    { protocolId: saved.id, date, dateFrom, decisions: count("decision"), tasks: count("task"), reports: count("report") },
    { headers: noStore },
  );
}
