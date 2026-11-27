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
import { foretagEventNow, orgEvent } from "@/lib/calendar/load";
import { orgMemberList } from "@/lib/db/members";
import { customerDomain, ownDomains } from "@/lib/foretag/customers";
import { createContextAction } from "@/app/(app)/privat/actions";
import { suggestedContext } from "@/lib/privat/contexts";
import { listContexts } from "@/lib/privat/contexts-db";
import { isPrivat, privatHref } from "@/lib/privat/space";
import { listGroups } from "@/lib/db/foretag";
import { hasTree, treeRows } from "@/lib/foretag/tree";

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

  // A Företag runs several meetings at once (0050): only the user's own running meeting sends them there.
  const busy = db.from("meetings").select("id, started_by").eq("org_id", orgId).in("status", ["live", "ending"]);
  const { data: active, error } = await (org.kind === "foretag" ? busy.eq("started_by", user.id) : busy).limit(1);
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

  // Företag (0050): "Möte för" (the starter's own group preselected) and Privat möte; always a new Enkel Doc.
  if (org.kind === "foretag") {
    const [groups, mine, event, members, people] = await Promise.all([
      listGroups(db, orgId),
      db.from("people").select("group_id").eq("org_id", orgId).eq("member_user_id", user.id).not("group_id", "is", null).limit(1),
      foretagEventNow(user.id),
      orgMemberList(orgId),
      db.from("people").select("name, member_user_id").eq("org_id", orgId),
    ]);
    // The event happening now in the starter's own calendar, offered, never attached by itself:
    // colleagues on its guest list (accepted ones pre-ticked) and, for the customer, its outside domain.
    const names = new Map(((people.data ?? []) as { name: string; member_user_id: string | null }[]).flatMap((p) => (p.member_user_id ? [[p.member_user_id, p.name] as const] : [])));
    const byEmail = new Map(members.map((m) => [m.email.toLowerCase(), m.userId]));
    const offered = event
      ? {
          id: event.id,
          title: event.title,
          colleagues: event.guests.flatMap((g) => {
            const id = byEmail.get(g.email.toLowerCase());
            return id && id !== user.id
              ? [{ userId: id, name: names.get(id) ?? g.name ?? g.email, accepted: g.response === "accepted", declined: g.response === "declined" }]
              : [];
          }),
          customerDomain: customerDomain(event.guests.map((g) => g.email), ownDomains(members.map((m) => m.email))),
        }
      : null;
    return (
      <main id="innehall">
        <LiveMeetingController
          orgId={org.id}
          orgName={org.name}
          orgHref={`/orgs/${org.id}`}
          shareTranscript={org.share_transcript}
          meeting={null}
          foretag={{
            groups: treeRows(groups).map(({ group, depth }) => ({ id: group.id, name: group.name, depth })),
            initialGroupId: ((mine.data ?? [])[0] as { group_id: string } | undefined)?.group_id ?? null,
            event: offered,
          }}
        />
      </main>
    );
  }

  // "Starta" on a calendar event (todo #14): its title for the consent step, read with the
  // starter's own grant (the start reads it again; nothing is taken from the URL but the id).
  // A förening with groups (0054): "Möte för" (the starter's own group preselected) and Privat möte.
  const [def, rows, goals, picked, tree] = await Promise.all([
    orgDefaultFormat(db, orgId),
    listOrgFormats(db, orgId),
    goalSuggestionsFor(db, orgId),
    event ? orgEvent(user.id, org, event) : Promise.resolve(null),
    hasTree(org)
      ? Promise.all([
          listGroups(db, orgId),
          db.from("people").select("group_id").eq("org_id", orgId).eq("member_user_id", user.id).not("group_id", "is", null).limit(1),
        ])
      : Promise.resolve(null),
  ]);
  const groupRows = tree ? treeRows(tree[0]) : [];

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
        groups={
          tree && groupRows.length
            ? {
                groups: groupRows.map(({ group, depth }) => ({ id: group.id, name: group.name, depth })),
                initialGroupId: ((tree[1].data ?? [])[0] as { group_id: string } | undefined)?.group_id ?? null,
              }
            : undefined
        }
      />
    </main>
  );
}
