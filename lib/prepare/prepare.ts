import "server-only";
import { randomUUID } from "node:crypto";
import type { OAuth2Client } from "google-auth-library";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkAgendaDoc } from "@/lib/agenda/access";
import { carriedItems, openTasks, previousMeetingOfKinds } from "@/lib/agenda/followup";
import { recurringTopics, type DashInput } from "@/lib/dashboard/overview";
import { loadOverviewInput } from "@/lib/dashboard/load";
import { orgMemberList } from "@/lib/db/members";
import { getOrg, myRole } from "@/lib/db/orgs";
import type { NoteItemRow } from "@/lib/db/types";
import { createFormatDoc, localDate, trashDoc } from "@/lib/docs/create";
import { parseNotesTab } from "@/lib/docs/tab";
import type { FormatProfile } from "@/lib/formats/schema";
import { skeletonBlocks } from "@/lib/formats/skeleton";
import { FORMAT_NAMES, STANDARD } from "@/lib/formats/standard";
import { ensureStandardRow, formatById, orgDefaultFormat } from "@/lib/formats/store";
import { getGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { docsApi, writeWithRevisionGuard, type DocsRequest } from "@/lib/google/docs";
import { ownerLabel, resolveOwner, type RolePerson } from "@/lib/people/roles";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { docUrl } from "@/lib/ui/meetings";
import { followupSource, importedCarried, type ImportedItem } from "./carry-source";
import type { GoalSuggestion } from "./goals";
import { goalSuggestionsFor } from "./goals-load";
import { followupKey, planCarried, planItemRanges, prepKey, prepMeeting, type DocLine, type Journal } from "./doc";
import { runReprepare } from "./reprepare";
import { preparedDocState } from "./stale";
import {
  buildDraft,
  droppedSources,
  kindsOfType,
  normaliseItems,
  refreshDraft,
  standardKindOf,
  validDate,
  type DraftItem,
  type MeetingType,
  type PrepareBody,
} from "./draft";
import { isOfferedType } from "./types";
import { acquireLease, missingTable, preparedForDate, releaseLease, type PreparedAgenda } from "./store";

// Förbered möte, server side: the draft (GET) and "Skapa dagordning" (POST). The Doc is written
// with the preparer's own Google grant (drive.file: Simon Says created it, so it may edit and
// share it); the förening's text is never logged (ids and counts only).

export type PrepareFailure = { ok: false; error: string; status: number; message: string };
const failed = (error: string, status: number, message: string): PrepareFailure => ({ ok: false, error, status, message });
const authLost = () => failed("google_auth_lost", 401, "Kopplingen till ditt Google-konto har gått ut. Logga ut och in igen.");
const googleDown = () => failed("google_unavailable", 502, "Vi nådde inte Google just nu. Försök igen om en liten stund.");

/** The file name: `2026-12-03 18.00 Dagordning – <förening>` (time when given), as the protocol naming. */
export function preparedTitle(orgName: string, date: string, time: string | null | undefined): string {
  return `${date}${time ? ` ${time.replace(":", ".")}` : ""} Dagordning – ${orgName.trim()}`;
}

/**
 * The format a meeting type runs in: the förening's own version of that kind when it is the
 * default; else its own Styrelsemöte / Årsmöte format (0035; the årsmöte's from the stadgar);
 * else the standard. Veckomöte is the förening's ordinary meeting: it runs in the default format,
 * a Styrelseprotokoll included (todo #15: no separate Styrelsemöte type, so a förening whose
 * default is Styrelseprotokoll keeps it).
 */
export async function formatForType(orgId: string, type: MeetingType): Promise<{ id: string | null; profile: FormatProfile }> {
  const def = await orgDefaultFormat(supabaseAdmin(), orgId);
  const k = def.profile.kind;
  const ordinary = k === "veckomote" || k === "learned" || k === "styrelseprotokoll";
  if (def.id && ((type === "veckomote" && ordinary) || (type === "styrelsemote" && k === "styrelseprotokoll"))) return def;
  if (type !== "veckomote") {
    const own = await typeFormat(orgId, type);
    if (own) return own;
  }
  return { id: null, profile: STANDARD[standardKindOf(type)] };
}

/** The förening's own format for a meeting type (orgs.styrelse_format_id / arsmote_format_id), if valid. */
async function typeFormat(orgId: string, type: "styrelsemote" | "arsmote"): Promise<{ id: string; profile: FormatProfile } | null> {
  const column = type === "arsmote" ? "arsmote_format_id" : "styrelse_format_id";
  const { data, error } = await supabaseAdmin().from("orgs").select(column).eq("id", orgId).maybeSingle();
  // Before 0035 the column is missing: fall back to the standard.
  if (error || !data) return null;
  const id = (data as Record<string, string | null>)[column];
  if (!id) return null;
  const profile = await formatById(id).catch(() => null);
  return profile && profile.kind === standardKindOf(type) ? { id, profile } : null;
}

interface Sources {
  profile: FormatProfile;
  formatId: string | null;
  prevId: string | null;
  carried: NoteItemRow[];
  people: RolePerson[];
  ownerLabel: (owner: string) => string;
  fresh: DraftItem[];
}

/**
 * The newest imported protocol of the org on or before `date` (0032); null when
 * there is none or it can't be read (a failed read never fails the draft).
 */
async function latestProtocol(orgId: string, date: string): Promise<{ id: string; date: string } | null> {
  const { data, error } = await supabaseAdmin()
    .from("history_protocols")
    .select("id, meeting_date")
    .eq("org_id", orgId)
    .lte("meeting_date", date)
    .order("meeting_date", { ascending: false })
    .order("imported_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error(`prepare: protocols unavailable: ${error.message}`);
    return null;
  }
  const row = (data ?? [])[0] as { id: string; meeting_date: string } | undefined;
  return row ? { id: row.id, date: row.meeting_date } : null;
}

/** Everything the draft is made from (service role, after the caller's membership check). `date`: the prepared date. */
async function sources(userDb: SupabaseClient, orgId: string, type: MeetingType, now: Date, date: string): Promise<Sources> {
  const db = supabaseAdmin();
  const { id: formatId, profile } = await formatForType(orgId, type);
  const groupBy = profile.tasksSection?.groupBy ?? "role";
  const hasFollowup = profile.fixedAgendaItems.some((i) => i.role === "followup");
  const [prev, protocol, ppl] = await Promise.all([
    hasFollowup ? previousMeetingOfKinds(orgId, now, kindsOfType(type), db) : Promise.resolve(null),
    hasFollowup ? latestProtocol(orgId, date) : Promise.resolve(null),
    db.from("people").select("id, name, role").eq("org_id", orgId),
  ]);
  if (ppl.error) throw new Error(`prepare: people: ${ppl.error.message}`);
  const people = (ppl.data ?? []) as RolePerson[];
  // The previous meeting, or an imported protocol newer than it (carry-source.ts).
  const pick = followupSource({
    prev: prev ? { id: prev.id, date: prev.startedAt ? localDate(new Date(prev.startedAt)) : "0000-00-00" } : null,
    protocol,
    preparedDate: date,
  });
  let carried: NoteItemRow[] = [];
  if (pick.use === "meeting" && prev) {
    const { data, error } = await db.from("note_items").select("*").eq("meeting_id", prev.id);
    if (error) throw new Error(`prepare: previous rows: ${error.message}`);
    carried = carriedItems(prev.id, openTasks((data ?? []) as NoteItemRow[]), "followup", people, groupBy);
  } else if (pick.use === "import" && protocol) {
    const { data, error } = await db
      .from("history_items")
      .select("position, kind, text, owner, done")
      .eq("org_id", orgId)
      .eq("protocol_id", protocol.id)
      .eq("kind", "task")
      .order("position");
    if (error) console.error(`prepare: protocol items unavailable: ${error.message}`);
    else carried = importedCarried(protocol.id, (data ?? []) as ImportedItem[], "followup", people, groupBy);
  }
  // Recurring topics (Översikt) and "Mål att ta upp" (the approved goals, todo #12), read with
  // the caller's client (RLS); neither ever fails the draft.
  let topics: { label: string; meetings: number }[] = [];
  let goals: GoalSuggestion[] = [];
  let overview: DashInput | null = null;
  try {
    overview = await loadOverviewInput(userDb, orgId);
    topics = recurringTopics(orgId, overview);
  } catch (err) {
    console.error(`prepare: topics unavailable: ${(err as Error).message}`);
  }
  if (overview) goals = await goalSuggestionsFor(userDb, orgId, now, overview);
  const label = (owner: string) => ownerLabel(resolveOwner(owner, people), owner, groupBy);
  const fresh = buildDraft({ profile, carried, ctx: { profile, ownerLabel: label }, topics, goals, ...(hasFollowup ? { origin: pick.origin } : {}) });
  return { profile, formatId, prevId: pick.use === "meeting" ? (prev?.id ?? null) : null, carried, people, ownerLabel: label, fresh };
}

/** A meeting has been held (or runs) in the prepared Doc: it is the meeting's now. */
async function usedByMeeting(orgId: string, docId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from("meetings")
    .select("id")
    .eq("org_id", orgId)
    .eq("doc_id", docId)
    .in("status", ["live", "ending", "done"])
    .limit(1);
  if (error) throw new Error(`prepare: used check: ${error.message}`);
  return (data ?? []).length > 0;
}

export interface DraftView {
  type: MeetingType;
  date: string;
  time: string | null;
  formatName: string;
  items: DraftItem[];
  /** Preparing again: the agenda already made for this date. */
  existing: { docUrl: string; docName: string; updatedAt: string; held: boolean } | null;
}

async function member(userDb: SupabaseClient, orgId: string) {
  const org = await getOrg(userDb, orgId);
  if (!org || (await myRole(userDb, orgId)) === null) return null;
  return org;
}

/** GET: the draft for `type` on `date` (an agenda already prepared for that date comes back to be edited, in its own type). */
export async function loadDraft(
  userDb: SupabaseClient,
  orgId: string,
  type: MeetingType,
  date: string,
  now = new Date(),
): Promise<{ ok: true; draft: DraftView } | PrepareFailure> {
  if (!(await member(userDb, orgId))) return failed("not_found", 404, "Föreningen finns inte.");
  if (!validDate(date)) return failed("bad_request", 400, "Datumet är ogiltigt.");
  const existing = await preparedForDate(orgId, date);
  // A Styrelsemöte is no longer offered (todo #15); only an agenda prepared as one keeps it.
  const kind = existing?.kind ?? (isOfferedType(type) ? type : "veckomote");
  const src = await sources(userDb, orgId, kind, now, date);
  const items = existing ? refreshDraft(existing.items, src.fresh, new Set(existing.dropped)) : src.fresh;
  return {
    ok: true,
    draft: {
      type: kind,
      date,
      time: existing?.meeting_time ?? null,
      formatName: FORMAT_NAMES[src.profile.kind],
      items,
      existing: existing
        ? { docUrl: docUrl(existing.doc_id), docName: existing.doc_name, updatedAt: existing.updated_at, held: await usedByMeeting(orgId, existing.doc_id) }
        : null,
    },
  };
}

export type SaveResult = { ok: true; docUrl: string; docName: string; date: string; created: boolean; reordered: boolean } | PrepareFailure;

/** POST: create the agenda Doc (or edit it, preparing again for the same date) and store the agenda. */
export async function savePrepared(
  userDb: SupabaseClient,
  user: { id: string; email?: string | null },
  orgId: string,
  body: PrepareBody,
  now = new Date(),
): Promise<SaveResult> {
  const org = await member(userDb, orgId);
  if (!org) return failed("not_found", 404, "Föreningen finns inte.");
  if (!validDate(body.date)) return failed("bad_request", 400, "Datumet är ogiltigt.");
  if (body.date < localDate(now)) return failed("past_date", 400, "Datumet har redan varit. Välj dagens datum eller ett senare.");

  let existing: PreparedAgenda | null;
  try {
    existing = await preparedForDate(orgId, body.date);
  } catch (err) {
    console.error(`prepare: lookup: ${(err as Error).message}`);
    return failed("save_failed", 500, "Dagordningen kunde inte sparas. Försök igen om en liten stund.");
  }
  if (!existing && !isOfferedType(body.type)) return failed("bad_request", 400, "Mötestypen är ogiltig.");
  const type = existing?.kind ?? body.type;
  const src = await sources(userDb, orgId, type, now, body.date);
  const items = normaliseItems(body.items, src.fresh);
  if (!items) return failed("empty", 400, "Dagordningen behöver minst en punkt.");
  if (existing && (await usedByMeeting(orgId, existing.doc_id))) {
    return failed("held", 409, "Mötet har redan hållits i den här dagordningen. Välj ett annat datum för nästa möte.");
  }

  let auth: OAuth2Client;
  try {
    auth = await getGoogleAuth(user.id);
  } catch (err) {
    if (err instanceof GoogleAuthLostError) return authLost();
    console.error(`prepare: google auth: ${(err as Error).message}`);
    return googleDown();
  }
  const dropped = droppedSources(items);
  const droppedSet = new Set(dropped);
  const followupOn = items.some((i) => i.role === "followup" && i.on);
  const desired = followupOn
    ? src.carried.filter((r) => !droppedSet.has(`${r.carried_from_meeting}:${r.carried_from_id}`))
    : [];

  try {
    if (existing) {
      // Its Doc is gone (trashed, or deleted: the preparer's own grant no longer sees it): the
      // stored agenda is dropped and a new Doc is made for the date.
      const state = preparedDocState(await checkAgendaDoc(auth, existing.doc_id), existing.prepared_by === user.id);
      if (state === "no_access") {
        return failed("prepared_no_access", 403, "Ditt Google-konto kommer inte åt dagordningen. Be den som förberedde mötet att ändra den.");
      }
      if (state === "gone") {
        const { error } = await supabaseAdmin().from("prepared_agendas").delete().eq("id", existing.id).eq("org_id", orgId);
        if (error) throw new Error(`stale delete: ${error.message}`);
        console.info(`prepare: ${existing.id} dropped (its Doc is gone)`);
        return await create(auth, user, org, items, desired, dropped, src, body, existing.kind);
      }
      return await update(auth, orgId, existing, items, desired, dropped, src, body);
    }
    return await create(auth, user, org, items, desired, dropped, src, body, type);
  } catch (err) {
    if (err instanceof GoogleAuthLostError) return authLost();
    console.error(`prepare: ${(err as Error).message}`);
    return googleDown();
  }
}

const docsOf = (auth: OAuth2Client) => docsApi(auth).documents;
const readTab = async (auth: OAuth2Client, docId: string, tabId: string) =>
  parseNotesTab((await docsOf(auth).get({ documentId: docId, includeTabsContent: true, suggestionsViewMode: "SUGGESTIONS_INLINE" })).data, tabId);

/** One revision-guarded batch planned from a fresh read (a conflict re-reads and re-plans). */
async function guarded<T>(
  auth: OAuth2Client,
  docId: string,
  tabId: string,
  plan: (tab: ReturnType<typeof parseNotesTab>) => { requests: DocsRequest[]; value: T; journal?: Journal },
  /** Called with the batch's journal right before it is sent (preparing again saves it there). */
  before?: (journal: Journal) => Promise<void>,
): Promise<T> {
  const { value } = await writeWithRevisionGuard(
    async () => {
      const tab = await readTab(auth, docId, tabId);
      return { tab, planned: plan(tab) };
    },
    async ({ tab, planned }) => {
      if (planned.requests.length) {
        await before?.(planned.journal ?? { writes: [], deletes: [] });
        await docsOf(auth).batchUpdate({ documentId: docId, requestBody: { requests: planned.requests, writeControl: { requiredRevisionId: tab.revisionId } } });
      }
      return planned.value;
    },
  );
  return value;
}

/** The carried lines rendered by the notes engine under the follow-up item (step 2 of both paths). */
async function writeCarried(
  auth: OAuth2Client,
  docId: string,
  tabId: string,
  key: string,
  lines: DocLine[],
  items: DraftItem[],
  stored: NoteItemRow[],
  desired: NoteItemRow[],
  src: Sources,
  rewritten: boolean,
): Promise<NoteItemRow[]> {
  return guarded(auth, docId, tabId, (tab) => {
    const fk = followupKey(tab, lines, items);
    const meeting = prepMeeting(key, docId, tabId, lines, items);
    const want = fk ? desired.map((r) => ({ ...r, anchor: fk })) : [];
    const { plan, rows } = planCarried(tab, meeting, stored, want, { profile: src.profile, ownerLabel: src.ownerLabel, rewritten });
    return { requests: plan.requests, value: rows };
  });
}

async function create(
  auth: OAuth2Client,
  user: { id: string; email?: string | null },
  org: { id: string; name: string; meeting_folder_id?: string | null },
  items: DraftItem[],
  desired: NoteItemRow[],
  dropped: string[],
  src: Sources,
  body: PrepareBody,
  type: MeetingType,
): Promise<SaveResult> {
  const id = randomUUID();
  const key = prepKey(id);
  const formatId = src.formatId ?? (await ensureStandardRow(org.id, standardKindOf(type)));
  const me = (user.email ?? "").toLowerCase();
  const members = (await orgMemberList(org.id)).filter((m) => m.userId !== user.id && m.email && m.email.toLowerCase() !== me);
  const title = preparedTitle(org.name, body.date, body.time);
  const on = items.filter((i) => i.on);
  const doc = await createFormatDoc(auth, {
    meetingId: key,
    orgName: org.name,
    startedAt: new Date(),
    title,
    meetingFolderId: org.meeting_folder_id ?? null,
    memberEmails: members.map((m) => m.email),
    shareTranscript: false,
    profile: src.profile,
    blocks: skeletonBlocks(src.profile, { items: on.map((i) => ({ label: i.label })) }),
  });
  const ok = new Set(doc.shared.map((e) => e.toLowerCase()));
  const sharedWith = members.filter((m) => ok.has(m.email.toLowerCase())).map((m) => m.userId);
  try {
    const lines = await guarded(auth, doc.docId, doc.tabId, (tab) => {
      const r = planItemRanges(tab, src.profile, key, items);
      return { requests: r.requests, value: r.lines };
    });
    const carried = await writeCarried(auth, doc.docId, doc.tabId, key, lines, items, [], desired, src, false);
    const { error } = await supabaseAdmin().from("prepared_agendas").insert({
      id,
      org_id: org.id,
      meeting_date: body.date,
      meeting_time: body.time ?? null,
      kind: type,
      format_profile_id: formatId,
      doc_id: doc.docId,
      tab_id: doc.tabId,
      doc_name: title,
      items,
      doc_lines: lines,
      carried,
      dropped,
      source_meeting_id: src.prevId,
      shared_with: sharedWith,
      prepared_by: user.id,
    });
    if (error) {
      if (missingTable(error.code)) throw new Error("prepared_agendas missing (0033 not applied)");
      throw new Error(`insert: ${error.code === "23505" ? "a prepared agenda for this date already exists" : error.message}`);
    }
    console.info(`prepare: created ${id} (items ${on.length}, carried ${carried.length}, shared ${sharedWith.length}, place ${doc.place})`);
    return { ok: true, docUrl: docUrl(doc.docId), docName: title, date: body.date, created: true, reordered: true };
  } catch (err) {
    // Never leave a half-made agenda in the förening's folder.
    await trashDoc(auth, doc.docId).catch((e: Error) => console.error(`prepare: trash after failure: ${e.message}`));
    throw err;
  }
}

async function update(
  auth: OAuth2Client,
  orgId: string,
  existing: PreparedAgenda,
  items: DraftItem[],
  desired: NoteItemRow[],
  dropped: string[],
  src: Sources,
  body: PrepareBody,
): Promise<SaveResult> {
  const key = prepKey(existing.id);
  const db = supabaseAdmin();
  // One preparer at a time; the plan is made from the row as it is once the lease is ours.
  const token = randomUUID();
  let fresh: PreparedAgenda | null = null;
  for (let i = 0; i < 10 && !fresh; i++) {
    fresh = await acquireLease(existing.id, token);
    if (!fresh) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!fresh) return failed("busy", 409, "Någon annan uppdaterar dagordningen just nu. Försök igen om en liten stund.");
  try {
    return await updateLeased(auth, orgId, fresh, key, items, desired, dropped, src, body);
  } finally {
    await releaseLease(existing.id, token);
  }
}

async function updateLeased(
  auth: OAuth2Client,
  orgId: string,
  existing: PreparedAgenda,
  key: string,
  items: DraftItem[],
  desired: NoteItemRow[],
  dropped: string[],
  src: Sources,
  body: PrepareBody,
): Promise<SaveResult> {
  const db = supabaseAdmin();
  const save = async (patch: Record<string, unknown>) => {
    const { error } = await db.from("prepared_agendas").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", existing.id).eq("org_id", orgId);
    if (error) throw new Error(`update: ${error.message}`);
  };
  const res = await runReprepare(
    { step: (plan, before) => guarded(auth, existing.doc_id, existing.tab_id, plan, before), save },
    {
      key,
      docId: existing.doc_id,
      tabId: existing.tab_id,
      profile: src.profile,
      ownerLabel: src.ownerLabel,
      lines: existing.doc_lines,
      carried: existing.carried,
      journal: existing.journal ?? null,
      gen: existing.gen ?? 0,
      items,
      desired,
    },
  );
  await save({ meeting_time: body.time ?? null, items, dropped, source_meeting_id: src.prevId });
  console.info(`prepare: updated ${existing.id} (${res.mode}, inserts ${res.inserts}, carried ${res.carried.length})`);
  return { ok: true, docUrl: docUrl(existing.doc_id), docName: existing.doc_name, date: existing.meeting_date, created: false, reordered: res.mode === "rewrite" };
}
