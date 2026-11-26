import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DriveAccessMissingError, getGoogleAuth, getImportGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import type { NotesClient } from "@/lib/notes/engine";
import { defaultLocale, type Locale } from "@/lib/i18n/config";
import { translator } from "@/lib/i18n/translator";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { extractProtocol } from "./extract";
import { MAX_DOC_CHARS, protocolDate } from "./extract-prompt";
import { fileCreatedDate, googleStatus, readProtocolDoc } from "./read-doc";
import { ownDocIds, saveImportedProtocol, transcriptTabIds } from "./store";

// ONE meeting of a picked Doc read with Claude and stored (the direct path): read the Doc with
// the admin's grant, claim one of the förening's 60 per 24 h (0032), one extraction call, save
// the cleaned items. Shared by POST /history/import and the job item route. Logs only counts.

export type ImportOneResult =
  | { ok: true; protocolId: string; date: string; dateFrom: "doc" | "file"; decisions: number; tasks: number; reports: number }
  | { ok: false; error: string; status: number; message: string };

const fail = (error: string, status: number, message: string): ImportOneResult => ({ ok: false, error, status, message });

export async function importOneSection(
  db: SupabaseClient,
  input: { userId: string; orgId: string; docId: string; section: number; sections: number; viaListing: boolean },
  opts: { client?: NotesClient; locale?: Locale } = {},
): Promise<ImportOneResult> {
  const t = translator(opts.locale ?? defaultLocale);
  const { orgId: id, docId } = input;
  let names: string[];
  let skipTabIds: Set<string>;
  try {
    skipTabIds = await transcriptTabIds(db, id);
    if ((await ownDocIds(db, id, [docId])).size) return fail("own_doc", 422, t("api.ownDoc"));
    const { data: people, error: peopleError } = await db.from("people").select("name").eq("org_id", id);
    if (peopleError) throw new Error(peopleError.message);
    names = ((people ?? []) as { name: string }[]).map((p) => p.name);
  } catch (err) {
    console.error(`history/import: ${(err as Error).message}`.slice(0, 200));
    return fail("error", 500, t("api.generic"));
  }

  let auth;
  let doc: Awaited<ReturnType<typeof readProtocolDoc>>;
  try {
    auth = input.viaListing ? await getImportGoogleAuth(input.userId) : await getGoogleAuth(input.userId);
    doc = await readProtocolDoc(auth, docId, { skipTabIds });
  } catch (err) {
    if (err instanceof DriveAccessMissingError) return fail("google_auth_lost", 401, t("api.driveAccessExpired"));
    if (err instanceof GoogleAuthLostError) return fail("google_auth_lost", 401, t("api.googleAuthLost"));
    const status = googleStatus(err);
    if (status === 403 || status === 404) return fail("doc_unreadable", 403, t("api.docUnreadableOne"));
    console.error(`history/import: doc: ${(err as Error).message}`.slice(0, 200));
    return fail("google_unavailable", 502, t("api.googleUnavailable"));
  }
  if (!doc.split.ok) {
    if (doc.split.reason === "empty") return fail("empty", 422, t("api.docEmpty"));
    return fail("many-meetings", 422, t("api.manyMeetings"));
  }
  // The split is deterministic: a different count means the Doc changed since the estimate.
  if (doc.split.sections.length !== input.sections) return fail("doc_changed", 409, t("api.docChanged"));
  const part = doc.split.sections[input.section];
  if (part.text.length > MAX_DOC_CHARS) return fail("too_long", 422, t("api.meetingTooLong"));

  // At most 60 per förening per 24 h: the daily Claude cap is shared by every förening's live notes.
  const { data: claimId, error: claimError } = await db.rpc("claim_history_import", { p_org_id: id });
  if (claimError) {
    if (claimError.code === "42501") return fail("forbidden", 403, t("api.historyAdminsOnly"));
    console.error(`history/import: claim: ${claimError.message}`.slice(0, 200));
    return fail("error", 500, t("api.generic"));
  }
  if (claimId === null || claimId === undefined) return fail("rate_limited", 429, t("api.importRateLimited"));

  const res = await extractProtocol({ orgId: id, title: part.title, text: part.text, people: names }, { client: opts.client });
  if (!res.ok) {
    // The spend gate, and Anthropic's 429/529, stop BEFORE the request ran: give that claim back
    // (service role, the server decides). A failed or timed-out request may have run: it stays.
    if (res.error === "spend" || res.error === "busy") {
      const { error } = await supabaseAdmin().rpc("release_history_import", { p_org_id: id, p_claim_id: claimId });
      if (error) console.error(`history/import: release: ${error.message}`.slice(0, 200));
    }
    if (res.error === "spend") return fail("spend", 503, t("api.importSpend"));
    if (res.error === "busy") return fail("busy", 503, t("api.claudeBusy"));
    return fail(res.error, 502, t("api.protocolFailed"));
  }

  let when = protocolDate(res.protocol.date, part.date, part.dateInferred);
  if (!when) {
    try {
      when = protocolDate(null, null, false, await fileCreatedDate(auth, docId));
    } catch (err) {
      console.error(`history/import: created: ${(err as Error).message}`.slice(0, 200));
    }
  }
  if (!when) return fail("no_date", 422, t("api.noDate"));

  const saved = await saveImportedProtocol(db, {
    orgId: id,
    driveFileId: docId,
    section: input.section,
    sections: input.sections,
    date: when.date,
    dateFrom: when.dateFrom,
    items: res.protocol.items,
  });
  if (!saved.ok) {
    if (saved.code === "42501") return fail("forbidden", 403, t("api.historyAdminsOnly"));
    console.error(`history/import: save: ${saved.message}`.slice(0, 200));
    return fail("save_failed", 500, t("api.protocolSaveFailed"));
  }
  const count = (k: string) => res.protocol.items.filter((i) => i.kind === k).length;
  console.info(`history/import: section ${input.section + 1}/${input.sections}, ${res.protocol.items.length} items, date from ${when.dateFrom}`);
  return { ok: true, protocolId: saved.id, date: when.date, dateFrom: when.dateFrom, decisions: count("decision"), tasks: count("task"), reports: count("report") };
}
