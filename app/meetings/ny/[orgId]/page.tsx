import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import type { AgendaFormatOption } from "@/components/live/AgendaStep";
import { LiveMeetingController } from "@/components/live/LiveMeetingController";
import { isUuid } from "@/lib/db/ids";
import { getOrg, myRole } from "@/lib/db/orgs";
import { getEnv, pickerEnabled } from "@/lib/env";
import { formatLabel, formatName } from "@/lib/formats/standard";
import type { Locale } from "@/lib/i18n/config";
import { listOrgFormats, orgDefaultFormat } from "@/lib/formats/store";
import { goalLabel } from "@/lib/prepare/goals";
import { goalSuggestionsFor } from "@/lib/prepare/goals-load";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { orgEvent } from "@/lib/calendar/load";
import { createContextAction } from "@/app/(app)/privat/actions";
import { suggestedContext } from "@/lib/privat/contexts";
import { listContexts } from "@/lib/privat/contexts-db";
import { isPrivat, privatHref } from "@/lib/privat/space";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("common"))("metaNewMeeting"), robots: { index: false, follow: false } };
}

/**
 * Start a meeting: the consent step of the live page. Start asks for the mic, then creates the
 * Doc and the meeting (POST /api/meetings) and continues on /meetings/<id> without reloading.
 * If the förening already has a running meeting, its starter goes there; others to the förening.
 */
/** Styrelseprotokoll is chosen in Mötesformat's "Byt format" (todo #15), so it is offered here only as the default or a saved version. */
const STANDARD_KINDS = ["veckomote", "arsmote", "enkel"] as const;

/**
 * The start screen's format choices: the förening's default first, the other standard formats,
 * then its custom versions (learned, or a Styrelseprotokoll with the stadgar's items: R3-I2).
 */
function startFormats(
  def: Awaited<ReturnType<typeof orgDefaultFormat>>,
  rows: Awaited<ReturnType<typeof listOrgFormats>>,
  locale: Locale,
): AgendaFormatOption[] {
  const defRow = rows.find((r) => r.id === def.id);
  const defName = defRow?.custom ? formatLabel(defRow, locale) : formatName(def.profile.kind, locale);
  const out: AgendaFormatOption[] = [{ id: def.id, kind: def.profile.kind, name: defName, isDefault: true }];
  for (const kind of STANDARD_KINDS) {
    // A custom default (e.g. Styrelseprotokoll with stadgar) still leaves the bare standard choosable.
    if (kind !== def.profile.kind || defRow?.custom) out.push({ id: null, kind, name: formatName(kind, locale), isDefault: false });
  }
  for (const r of rows) {
    if (r.custom && r.id !== def.id) out.push({ id: r.id, kind: r.kind, name: formatLabel(r, locale), isDefault: false });
  }
  return out;
}

export default async function NewMeetingPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ sammanhang?: string; event?: string }>;
}) {
  const { orgId } = await params;
  const { sammanhang, event } = await searchParams;
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

  // Privat (0045): pick a context instead of an agenda; no Doc unless asked for.
  if (isPrivat(org)) {
    const contexts = await listContexts(db, orgId);
    const from = contexts.find((c) => c.id === sammanhang);
    const tp = await getTranslations("privat");
    return (
      <main id="innehall">
        <LiveMeetingController
          orgId={org.id}
          orgName={from?.name ?? tp("home.title")}
          orgHref={from ? privatHref(from.id) : privatHref()}
          shareTranscript={false}
          meeting={null}
          privat={{
            contexts: contexts.map(({ id, name }) => ({ id, name })),
            initialContextId: from?.id ?? suggestedContext(contexts)?.id ?? null,
            createContext: createContextAction,
            summaryHref: null,
            backLabel: from ? tp("live.back", { name: from.name }) : tp("live.backHome"),
          }}
        />
      </main>
    );
  }

  // "Starta" on a calendar event (todo #14): its title for the consent step, read with the
  // starter's own grant (the start reads it again; nothing is taken from the URL but the id).
  const [def, rows, goals, picked] = await Promise.all([
    orgDefaultFormat(db, orgId),
    listOrgFormats(db, orgId),
    goalSuggestionsFor(db, orgId),
    event ? orgEvent(user.id, org, event) : Promise.resolve(null),
  ]);

  return (
    <main id="innehall">
      <LiveMeetingController
        orgId={org.id}
        orgName={org.name}
        orgHref={`/orgs/${org.id}`}
        shareTranscript={org.share_transcript}
        meeting={null}
        formats={startFormats(def, rows, await getLocale())}
        pickerEnabled={pickerEnabled(getEnv())}
        goals={goals.map((g) => ({ id: g.goalId, label: goalLabel(g.title), reason: g.reason }))}
        calendarEvent={picked ? { id: picked.id, title: picked.title } : null}
      />
    </main>
  );
}
