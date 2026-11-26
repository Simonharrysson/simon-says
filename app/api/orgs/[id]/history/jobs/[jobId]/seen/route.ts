import { NextResponse, type NextRequest } from "next/server";
import { apiT } from "@/lib/i18n/api";
import { isUuid } from "@/lib/db/ids";
import { isOpen } from "@/lib/history/progress";
import { loadJob } from "@/lib/history/jobs";
import { fail, noStore, requireAdmin } from "@/lib/history/route-kit";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** "Stäng" on a finished import (admins): the Översikt stops showing it. Open imports stay. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; jobId: string }> }) {
  const t = apiT(request);
  const { id, jobId } = await params;
  const guard = await requireAdmin(id, t);
  if (!guard.ok) return guard.reply;
  if (!isUuid(jobId)) return fail("not_found", 404, t("api.jobNotFound"));
  const admin = supabaseAdmin();
  const job = await loadJob(admin, jobId).catch(() => null);
  if (!job || job.org_id !== id) return fail("not_found", 404, t("api.jobNotFound"));
  if (isOpen(job.status)) return fail("running", 409, t("api.jobRunning"));
  const { error } = await admin.from("history_import_jobs").update({ seen_at: new Date().toISOString() }).eq("id", jobId);
  if (error) return fail("error", 500, t("api.generic"));
  return NextResponse.json({ ok: true }, { headers: noStore });
}
