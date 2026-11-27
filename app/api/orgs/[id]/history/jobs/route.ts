import { refuseForetag } from "@/lib/foretag/guard";
import { NextResponse, type NextRequest } from "next/server";
import { apiT } from "@/lib/i18n/api";
import { DRIVE_ID } from "@/lib/agenda/candidates";
import { dayUsd } from "@/lib/db/usage";
import { getEnv } from "@/lib/env";
import { DriveAccessMissingError, getGoogleAuth, getImportGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { estimateImport } from "@/lib/history/cost";
import { createBatchJob, createDirectJob, currentJobId, jobView, type NewItem } from "@/lib/history/jobs";
import { MAX_IMPORT_DOCS } from "@/lib/history/limits";
import { BATCH_SPEND_SHARE, importMode, MAX_BATCH_PROTOCOLS, neutralLabel } from "@/lib/history/progress";
import { googleStatus } from "@/lib/history/read-doc";
import { readPickedDocs } from "@/lib/history/read-picked";
import { batchClient, fail, noStore, requireAdmin } from "@/lib/history/route-kit";
import { historySummary, ownDocIds, transcriptTabIds } from "@/lib/history/store";
import { checkTicket } from "@/lib/history/ticket";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
// A batch job reads every picked Doc (six at a time) before it sends them in one batch.
export const maxDuration = 300;

/** The import the Översikt shows (open, or finished and not yet closed): `{ job }` or `{ job: null }`. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const t = apiT(request);
  const { id } = await params;
  // Förening only: never for a Företag (0050, lib/foretag/guard.ts).
  const foretagRefusal = await refuseForetag(id);
  if (foretagRefusal) return foretagRefusal;
  const guard = await requireAdmin(id, t);
  if (!guard.ok) return guard.reply;
  try {
    const admin = supabaseAdmin();
    const jobId = await currentJobId(admin, id);
    return NextResponse.json({ job: jobId ? await jobView(admin, jobId) : null }, { headers: noStore });
  } catch (err) {
    console.error(`history/jobs: ${(err as Error).message}`.slice(0, 200));
    return fail("error", 500, t("api.generic"));
  }
}

interface PickedBody {
  docs?: unknown;
  tickets?: unknown;
}

/**
 * Starts an import of the confirmed pick: `{ docs: [{ docId, sections }], tickets? }` (the
 * estimate's answer; no file names: the browser keeps those, they are never stored). Up to DIRECT_MAX meetings: a direct job, the browser then reads each
 * meeting through /jobs/[jobId]/items/[itemId]. More: every Doc is read now and ALL meetings go
 * in one Anthropic batch (half price); the import cron saves the results and proposes goals.
 * Admins only; one open import per förening; batch: at most 500 meetings per 24 h and only when
 * the estimate fits today's Claude budget for imports. → `{ job }` (the job view).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const t = apiT(request);
  const { id } = await params;
  // Förening only: never for a Företag (0050, lib/foretag/guard.ts).
  const foretagRefusal = await refuseForetag(id);
  if (foretagRefusal) return foretagRefusal;
  const guard = await requireAdmin(id, t);
  if (!guard.ok) return guard.reply;
  const { db, userId } = guard;

  const body = (await request.json().catch(() => null)) as PickedBody | null;
  const raw = Array.isArray(body?.docs) ? (body.docs as { docId?: unknown; sections?: unknown }[]) : [];
  const docs = raw.flatMap((d) =>
    typeof d?.docId === "string" && DRIVE_ID.test(d.docId) && Number.isInteger(d.sections) && (d.sections as number) >= 1 && (d.sections as number) <= 60
      ? [{ docId: d.docId, sections: d.sections as number }]
      : [],
  );
  if (!docs.length || docs.length !== raw.length || docs.length > MAX_IMPORT_DOCS || new Set(docs.map((d) => d.docId)).size !== docs.length) {
    return fail("bad_request", 400, t("api.pickProtocols", { max: MAX_IMPORT_DOCS }));
  }
  const tickets = body?.tickets && typeof body.tickets === "object" ? (body.tickets as Record<string, unknown>) : null;
  if (tickets && !docs.every((d) => checkTicket(tickets[d.docId], userId, id, d.docId))) {
    return fail("stale_list", 400, t("api.staleList"));
  }
  const viaListing = Boolean(tickets);
  const meetings = docs.reduce((n, d) => n + d.sections, 0);
  if (meetings > MAX_BATCH_PROTOCOLS) return fail("too_many", 400, t("api.tooManyMeetings", { count: meetings, max: MAX_BATCH_PROTOCOLS }));
  // Stored labels are neutral: file names are never stored (/integritet); the browser keeps them.
  const docIndex = new Map(docs.map((d, k) => [d.docId, k]));
  const label = (d: { docId: string }, section: number, sections: number) => neutralLabel(docIndex.get(d.docId) ?? 0, section, sections);

  let own: Set<string>;
  let skipTabIds: Set<string>;
  try {
    [own, skipTabIds] = await Promise.all([ownDocIds(db, id, docs.map((d) => d.docId)), transcriptTabIds(db, id)]);
  } catch (err) {
    console.error(`history/jobs: ${(err as Error).message}`.slice(0, 200));
    return fail("error", 500, t("api.generic"));
  }
  const admin = supabaseAdmin();

  let created;
  if (importMode(meetings) === "direct") {
    const items: NewItem[] = docs.flatMap((d) =>
      Array.from({ length: d.sections }, (_, k) => ({ docId: d.docId, section: k, sections: d.sections, label: label(d, k, d.sections), ...(own.has(d.docId) ? { skip: "own_doc" } : {}) })),
    );
    created = await createDirectJob(admin, { orgId: id, userId, viaListing, estimateUsd: 0, items });
  } else {
    // Batch: read every Doc now (the text goes into the batch and is dropped), then submit.
    const items: NewItem[] = [];
    const chars: number[] = [];
    try {
      const auth = viaListing ? await getImportGoogleAuth(userId) : await getGoogleAuth(userId);
      const read = await readPickedDocs(auth, docs.map((d) => d.docId), { own, skipTabIds, withFileDate: true });
      for (const [k, r] of read.entries()) {
        const d = docs[k];
        if (!r.ok) {
          items.push({ docId: d.docId, section: 0, sections: 1, label: label(d, 0, 1), skip: r.reason });
          continue;
        }
        const n = r.sections.length;
        for (const [s, part] of r.sections.entries()) {
          items.push({ docId: d.docId, section: s, sections: n, label: label(d, s, n), part, fileDate: r.fileDate });
          chars.push(part.text.length);
        }
      }
    } catch (err) {
      if (err instanceof DriveAccessMissingError) return fail("google_auth_lost", 401, t("api.driveAccessExpired"));
      if (err instanceof GoogleAuthLostError) return fail("google_auth_lost", 401, t("api.googleAuthLost"));
      const status = googleStatus(err);
      if (status === 403 || status === 404) return fail("doc_unreadable", 403, t("api.docUnreadable"));
      console.error(`history/jobs: docs: ${(err as Error).message}`.slice(0, 200));
      return fail("google_unavailable", 502, t("api.googleUnavailable"));
    }
    if (items.length > MAX_BATCH_PROTOCOLS) return fail("too_many", 400, t("api.tooManyMeetings", { count: items.length, max: MAX_BATCH_PROTOCOLS }));
    const env = getEnv();
    if (env.KILL_SWITCH) return fail("spend", 503, t("api.importSpend"));
    let spendRoom: number;
    let ownMeetings = 0;
    try {
      const [today, m, h] = await Promise.all([
        dayUsd(),
        db.from("meetings").select("id", { count: "exact", head: true }).eq("org_id", id).eq("is_test", false).in("status", ["done", "abandoned"]),
        historySummary(db, id).catch(() => ({ count: 0 })),
      ]);
      spendRoom = BATCH_SPEND_SHARE * env.GLOBAL_DAILY_USD - today;
      ownMeetings = (m.count ?? 0) + h.count;
    } catch (err) {
      console.error(`history/jobs: spend: ${(err as Error).message}`.slice(0, 200));
      return fail("error", 500, t("api.generic"));
    }
    const e = estimateImport(chars, ownMeetings);
    created = await createBatchJob(admin, batchClient(), { orgId: id, userId, viaListing, estimateUsd: e.totalUsd, spendRoom, items });
  }

  if (!created.ok) {
    if (created.error === "busy") return fail("busy", 409, t("api.importBusy"));
    if (created.error === "rate_limited") return fail("rate_limited", 429, t("api.batchRateLimited"));
    if (created.error === "spend") return fail("spend", 503, t("api.importTooBig"));
    if (created.error === "submit") return fail("submit", 502, t("api.importSubmitFailed"));
    return fail("error", 500, t("api.generic"));
  }
  console.info(`history/jobs: ${meetings} meetings, ${importMode(meetings)}`);
  return NextResponse.json({ job: await jobView(admin, created.jobId) }, { headers: noStore });
}
