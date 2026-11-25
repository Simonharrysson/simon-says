import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { AgendaFormatOption } from "@/components/live/AgendaStep";
import { LiveMeetingController } from "@/components/live/LiveMeetingController";
import { isUuid } from "@/lib/db/ids";
import { getOrg, myRole } from "@/lib/db/orgs";
import { getEnv, pickerEnabled } from "@/lib/env";
import { FORMAT_NAMES } from "@/lib/formats/standard";
import { listOrgFormats, orgDefaultFormat } from "@/lib/formats/store";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Nytt möte", robots: { index: false, follow: false } };

/**
 * Start a meeting: the consent step of the live page. Start asks for the mic, then creates the
 * Doc and the meeting (POST /api/meetings) and continues on /meetings/<id> without reloading.
 * If the förening already has a running meeting, its starter goes there; others to the förening.
 */
const STANDARD_KINDS = ["veckomote", "styrelseprotokoll", "enkel"] as const;

/** The start screen's format choices: the förening's default first, the other standard formats, then its learned versions. */
function startFormats(
  def: Awaited<ReturnType<typeof orgDefaultFormat>>,
  rows: Awaited<ReturnType<typeof listOrgFormats>>,
): AgendaFormatOption[] {
  const out: AgendaFormatOption[] = [{ id: def.id, kind: def.profile.kind, name: FORMAT_NAMES[def.profile.kind], isDefault: true }];
  for (const kind of STANDARD_KINDS) {
    if (kind !== def.profile.kind) out.push({ id: null, kind, name: FORMAT_NAMES[kind], isDefault: false });
  }
  for (const r of rows) {
    if (r.kind === "learned" && r.id !== def.id) {
      out.push({ id: r.id, kind: r.kind, name: `${FORMAT_NAMES.learned} (${r.createdAt.slice(0, 10)})`, isDefault: false });
    }
  }
  return out;
}

export default async function NewMeetingPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect(`/login?next=/meetings/ny/${isUuid(orgId) ? orgId : ""}`);
  if (!isUuid(orgId)) notFound();
  const org = await getOrg(db, orgId);
  if (!org || (await myRole(db, orgId)) === null) notFound();

  const { data: active, error } = await db
    .from("meetings")
    .select("id, started_by")
    .eq("org_id", orgId)
    .in("status", ["live", "ending"])
    .limit(1);
  if (error) throw new Error(`new meeting page: ${error.message}`);
  const running = active?.[0];
  if (running) redirect(running.started_by === user.id ? `/meetings/${running.id}` : `/orgs/${orgId}`);

  const [def, rows] = await Promise.all([orgDefaultFormat(db, orgId), listOrgFormats(db, orgId)]);

  return (
    <main id="innehall">
      <LiveMeetingController
        orgId={org.id}
        orgName={org.name}
        orgHref={`/orgs/${org.id}`}
        shareTranscript={org.share_transcript}
        meeting={null}
        formats={startFormats(def, rows)}
        pickerEnabled={pickerEnabled(getEnv())}
      />
    </main>
  );
}
