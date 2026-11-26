import type { ReactNode } from "react";
import Link from "next/link";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Banner } from "@/components/ui/Banner";
import { ButtonLink, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmAction, type FormAction } from "@/components/ui/ConfirmAction";
import { CopyField } from "@/components/ui/CopyField";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconArrowRight, IconExternal, IconMic, IconPlay, IconPlus, IconRefresh, IconTrash } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { MeetingStatus } from "@/lib/db/types";
import { formatDateTime, formatDuration, formatMeetingDate, plural } from "@/lib/format";
import { canResume, docUrl, meetingDeleteState, meetingStatusLabel } from "@/lib/ui/meetings";
import type { Notice } from "@/lib/ui/messages";
import { DocAccessButton } from "./DocAccessButton";
import { NoticeBanner } from "./NoticeBanner";
import type { DocAccess } from "@/lib/docs/access-state";
import { OrgSettingsForm } from "./OrgSettingsForm";
import { PersonRow } from "./PersonRow";

export interface OrgDetailMeeting {
  id: string;
  status: MeetingStatus;
  started_at: string;
  ended_at: string | null;
  doc_id: string;
  started_by: string | null;
}

export interface OrgDetailViewProps {
  org: { id: string; name: string; share_transcript: boolean; show_on_status: boolean };
  isAdmin: boolean;
  userId: string | null;
  inviteUrl: string;
  /** Members (email, role), oldest first. Omitted when unavailable. */
  members?: { userId: string; email: string; role: "admin" | "member" }[];
  people: { id: string; name: string; role?: string | null }[];
  meetings: OrgDetailMeeting[];
  /** The viewer's sign-in address: meeting Docs are shared to it. */
  viewerEmail?: string | null;
  /** Per meeting id; a meeting not in the map is `open` (e.g. the /design gallery). */
  docAccess?: Record<string, DocAccess>;
  notice: Notice | null;
  /** The "Starta möte" form, shown while no meeting is running. Omitted: no start panel. */
  startMeeting?: ReactNode;
  /** Link to start a meeting (Task 7). Hidden until the live page exists. */
  startMeetingHref?: string;
  /** The meeting-format card (`FormatCard`), shown above the people panel. */
  formatCard?: ReactNode;
  /**
   * Link into a meeting's live page (Task 7), e.g. id => `/meetings/${id}`. Shown only to the
   * person who started it (only they can run it): running meetings and ones abandoned < 2 h ago.
   * Hidden when absent.
   */
  liveMeetingHref?: (meetingId: string) => string;
  /**
   * The "Översikt" tab (org dashboard): when given, a tab bar shows under the header and
   * `active === "oversikt"` renders `overview` instead of the meetings page; `href` builds the links.
   */
  tabs?: { active: OrgTab; href: (tab: OrgTab) => string; overview?: ReactNode };
  actions: {
    rotateInvite: FormAction;
    addPerson: FormAction;
    renamePerson: FormAction;
    /** Admins: set or clear a person's role (hidden `orgId`, `personId`, field `role`). */
    setPersonRole?: FormAction;
    deletePerson: FormAction;
    deleteMeeting: FormAction;
    updateOrg: FormAction;
    deleteOrg: FormAction;
    /** Admins: remove a member (hidden `orgId`, `userId`). */
    removeMember?: FormAction;
    /** Leave the org yourself (hidden `orgId`). */
    leaveOrg?: FormAction;
  };
}

export type OrgTab = "moten" | "oversikt";
const TABS: { id: OrgTab; label: string }[] = [
  { id: "moten", label: "Möten" },
  { id: "oversikt", label: "Översikt" },
];

/** Server-rendered tabs: links with aria-current, so the URL can be shared and reloaded. */
function OrgTabs({ active, href }: { active: OrgTab; href: (tab: OrgTab) => string }) {
  return (
    <nav aria-label="Föreningens vyer" className="-mt-2 flex gap-1 border-b border-line">
      {TABS.map((t) => (
        <Link
          key={t.id}
          href={href(t.id)}
          aria-current={t.id === active ? "page" : undefined}
          className="-mb-px inline-flex min-h-10 items-center border-b-2 border-transparent px-3 text-sm font-medium text-ink-3 no-underline transition-colors duration-120 hover:text-ink aria-[current=page]:border-ink aria-[current=page]:text-ink max-md:min-h-11"
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

const statusTone: Record<MeetingStatus, BadgeTone> = {
  live: "live",
  ending: "neutral",
  done: "success",
  abandoned: "neutral",
};

export function OrgDetailView(props: OrgDetailViewProps) {
  const { org, isAdmin, userId, inviteUrl, members, people, meetings, docAccess, viewerEmail, notice, startMeeting, startMeetingHref, formatCard, liveMeetingHref, tabs, actions } = props;
  const access = (m: OrgDetailMeeting): DocAccess => docAccess?.[m.id] ?? "open";
  const starter = (m: OrgDetailMeeting) => members?.find((x) => x.userId === m.started_by)?.email || "den som startade mötet";
  const active = meetings.find((m) => m.status === "live" || m.status === "ending");
  const running = liveMeetingHref && active && userId !== null && active.started_by === userId ? active : null;
  const nameError = notice?.text.startsWith("Ange ett namn") ? notice.text : undefined;

  return (
    <div className="mx-auto w-full max-w-page px-gutter flex flex-col gap-6">
      <PageHeader
        back={{ href: "/orgs", label: "Föreningar" }}
        title={org.name}
        meta={
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={isAdmin ? "info" : "neutral"}>{isAdmin ? "Du är admin" : "Du är medlem"}</Badge>
            <span className="text-sm text-ink-3">
              {plural(people.length, "person", "personer")} · {plural(meetings.length, "möte", "möten")}
            </span>
          </div>
        }
        actions={
          running && liveMeetingHref ? (
            <ButtonLink href={liveMeetingHref(running.id)} variant="primary" size="lg" icon={<IconPlay size={18} />}>
              Fortsätt mötet
            </ButtonLink>
          ) : (
            startMeetingHref && (
              <ButtonLink href={startMeetingHref} variant="primary" size="lg" icon={<IconMic />}>
                Starta ett möte
              </ButtonLink>
            )
          )
        }
      />
      {tabs && <OrgTabs active={tabs.active} href={tabs.href} />}
      <NoticeBanner notice={notice} />

      {tabs?.active === "oversikt" ? (
        tabs.overview
      ) : (
      <>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] items-start gap-6 max-[56rem]:grid-cols-[minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          {active ? (
            <Banner tone="info" title="Ett möte pågår" live={false}>
              {access(active) !== "open" && active.started_by !== userId ? (
                <div className="flex flex-col items-start gap-2">
                  <p>Anteckningarna skrivs i mötesdokumentet. Ett nytt möte kan startas när det är avslutat.</p>
                  <DocAccessButton
                    meetingId={active.id}
                    docHref={docUrl(active.doc_id)}
                    starter={starter(active)}
                    email={viewerEmail}
                    askOnly={access(active) === "ask"}
                  />
                </div>
              ) : (
                <p>
                  Anteckningarna skrivs i{" "}
                  <a href={docUrl(active.doc_id)} target="_blank" rel="noopener noreferrer">
                    mötesdokumentet
                  </a>
                  . Ett nytt möte kan startas när det är avslutat.
                </p>
              )}
            </Banner>
          ) : (
            startMeeting && (
              <Panel title="Starta möte" titleId="start-title">
                {startMeeting}
              </Panel>
            )
          )}
          <MeetingsPanel
            meetings={meetings}
            orgId={org.id}
            isAdmin={isAdmin}
            userId={userId}
            viewerEmail={viewerEmail}
            access={access}
            starter={starter}
            deleteMeeting={actions.deleteMeeting}
            liveMeetingHref={liveMeetingHref}
          />
          {formatCard}
          <PeoplePanel orgId={org.id} people={people} isAdmin={isAdmin} actions={actions} />
        </div>

        <div className="flex flex-col gap-6">
          <Panel title="Bjud in" titleId="invite-title">
            <div className="flex flex-col gap-3">
              <p className="text-sm text-ink-3">
                Den som öppnar länken och loggar in med Google blir medlem och kan starta möten.
              </p>
              <CopyField id="invite-url" value={inviteUrl} label="Inbjudningslänk" />
              {isAdmin && (
                <div>
                  <ConfirmAction
                    action={actions.rotateInvite}
                    hidden={{ orgId: org.id }}
                    trigger="Skapa ny länk"
                    triggerVariant="ghost"
                    triggerIcon={<IconRefresh size={18} />}
                    title="Skapa en ny inbjudningslänk?"
                    description="Den gamla länken slutar fungera direkt. Den som redan är medlem påverkas inte."
                    confirmLabel="Skapa ny länk"
                    confirmVariant="primary"
                    pendingLabel="Skapar…"
                  />
                </div>
              )}
            </div>
          </Panel>

          {members && (
            <Panel flush title="Medlemmar" titleId="members-title" actions={<span className="text-sm text-ink-3">{members.length}</span>}>
              <p className="text-sm text-ink-3 -mt-2 px-6 pb-4">Kan logga in, starta möten och får tillgång till nya mötesdokument.</p>
              <ul  aria-labelledby="members-title">
                {members.map((m) => {
                  const me = userId !== null && m.userId === userId;
                  const label = m.email || "Okänd medlem";
                  return (
                    <li key={m.userId}>
                      <div className="flex items-center gap-3 border-t border-line px-6 [li:first-child>&]:border-t-0 min-h-11 py-2">
                        <span className="flex min-w-0 flex-1 flex-col gap-[0.1rem]">
                          <span className="text-sm font-medium wrap-anywhere">{label}</span>
                          {(m.role === "admin" || me) && (
                            <span className="text-sm text-ink-3">{[m.role === "admin" ? "admin" : null, me ? "du" : null].filter(Boolean).join(" · ")}</span>
                          )}
                        </span>
                        {me && actions.leaveOrg ? (
                          <ConfirmAction
                            action={actions.leaveOrg}
                            hidden={{ orgId: org.id }}
                            trigger="Lämna"
                            triggerVariant="ghost"
                            triggerSize="sm"
                            title={`Lämna ${org.name}?`}
                            description="Du ser inte längre föreningens möten och får inte nya mötesdokument. Dokument som redan delats med dig ligger kvar i din Drive. Du kan gå med igen via en inbjudningslänk."
                            confirmLabel="Lämna föreningen"
                            pendingLabel="Lämnar…"
                          />
                        ) : (
                          isAdmin &&
                          !me &&
                          actions.removeMember && (
                            <ConfirmAction
                              action={actions.removeMember}
                              hidden={{ orgId: org.id, userId: m.userId }}
                              trigger="Ta bort"
                              triggerVariant="ghost"
                              triggerSize="sm"
                              title={`Ta bort ${label}?`}
                              description="Hen ser inte längre föreningens möten och får inte nya mötesdokument. Mötesdokument som redan delats med hen förblir delade – ta bort delningen i Google Drive om det behövs. Inbjudningslänken fungerar fortfarande, så skapa en ny länk om hen inte ska kunna gå med igen."
                              confirmLabel="Ta bort medlemmen"
                              pendingLabel="Tar bort…"
                            />
                          )
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          )}
        </div>
      </div>

      {isAdmin && (
        <>
          <Panel title="Inställningar" titleId="settings-title" id="installningar">
            <OrgSettingsForm org={org} updateOrg={actions.updateOrg} nameError={nameError} />
          </Panel>

          <Panel title="Radera föreningen" titleId="danger-title" className="shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_40%,var(--line))]">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-sm text-ink-3 max-w-[68ch]">
                Tar bort föreningen med alla möten, transkriptioner, anteckningar och personer här. Det går
                inte att ångra. Google-dokumenten ligger kvar i Drive.
              </p>
              <ConfirmAction
                action={actions.deleteOrg}
                hidden={{ orgId: org.id }}
                trigger="Radera föreningen"
                triggerVariant="danger"
                triggerSize="md"
                triggerIcon={<IconTrash size={18} />}
                title={`Radera ${org.name}?`}
                description="Alla möten, transkriptioner, anteckningar och personer försvinner. Google-dokumenten ligger kvar i Drive."
                requireText={{
                  name: "confirmName",
                  value: org.name,
                  label: (
                    <>
                      Skriv <strong>{org.name}</strong> för att bekräfta
                    </>
                  ),
                }}
                confirmLabel="Radera för alltid"
                pendingLabel="Raderar…"
              />
            </div>
          </Panel>
        </>
      )}
      </>
      )}
    </div>
  );
}

function MeetingsPanel({
  meetings,
  orgId,
  isAdmin,
  userId,
  deleteMeeting,
  liveMeetingHref,
  access,
  starter,
  viewerEmail,
}: {
  viewerEmail?: string | null;
  access: (m: OrgDetailMeeting) => DocAccess;
  starter: (m: OrgDetailMeeting) => string;
  meetings: OrgDetailMeeting[];
  orgId: string;
  isAdmin: boolean;
  userId: string | null;
  deleteMeeting: FormAction;
  liveMeetingHref?: (meetingId: string) => string;
}) {
  return (
    <Panel flush title="Möten" titleId="meetings-title">
      {meetings.length === 0 ? (
        <div className="px-6 pb-6">
          <EmptyState title="Inga möten än">
            <p>
              När någon startar ett möte skapas ett Google-dokument i föreningens mötesmapp (eller i
              startarens Drive) och delas med föreningens medlemmar. Mötet hamnar här, med en länk
              till dokumentet.
            </p>
          </EmptyState>
        </div>
      ) : (
        <>
          <ul  aria-labelledby="meetings-title">
            {meetings.map((meeting) => {
              const state = meetingDeleteState(meeting, { isAdmin, userId });
              const mine = userId !== null && meeting.started_by === userId;
              const duration =
                meeting.ended_at &&
                formatDuration((new Date(meeting.ended_at).getTime() - new Date(meeting.started_at).getTime()) / 1000);
              return (
                <li key={meeting.id}>
                  <div className="flex min-h-14 items-center gap-3 border-t border-line px-6 py-3 [li:first-child>&]:border-t-0 max-[30rem]:flex-wrap">
                    <span className="flex min-w-0 flex-1 flex-col gap-[0.1rem]">
                      <span className="font-medium wrap-anywhere">{formatMeetingDate(meeting.started_at)}</span>
                      <span className="mt-[0.15rem] flex flex-wrap items-center gap-2 text-xs text-ink-3">
                        <Badge tone={statusTone[meeting.status]}>{meetingStatusLabel[meeting.status]}</Badge>
                        {duration && <span>{duration}</span>}
                        {state === "active" && <span>Avsluta mötet innan du raderar det.</span>}
                      </span>
                    </span>
                    <span className="flex flex-none items-center gap-1 max-[30rem]:w-full">
                      {state === "active" && mine && liveMeetingHref && (
                        <ButtonLink href={liveMeetingHref(meeting.id)} variant="primary" size="sm" icon={<IconArrowRight size={16} />}>
                          Till mötet
                        </ButtonLink>
                      )}
                      {meeting.status === "abandoned" && mine && liveMeetingHref && canResume(meeting) && (
                        <ButtonLink href={liveMeetingHref(meeting.id)} size="sm" icon={<IconPlay size={16} />}>
                          Fortsätt mötet
                        </ButtonLink>
                      )}
                      {access(meeting) !== "open" && !mine ? (
                        <DocAccessButton
                          meetingId={meeting.id}
                          docHref={docUrl(meeting.doc_id)}
                          starter={starter(meeting)}
                          email={viewerEmail}
                          askOnly={access(meeting) === "ask"}
                        />
                      ) : (
                        <a
                          className={buttonVariants({ size: "sm" })}
                          href={docUrl(meeting.doc_id)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Dokument
                          <IconExternal size={16} />
                          <span className="sr-only">(öppnas i ny flik)</span>
                        </a>
                      )}
                      {state === "allowed" && (
                        <ConfirmAction
                          action={deleteMeeting}
                          hidden={{ orgId, meetingId: meeting.id }}
                          trigger={`Radera mötet ${formatDateTime(meeting.started_at)}`}
                          triggerIcon={<IconTrash size={18} />}
                          triggerIconOnly
                          triggerVariant="danger-ghost"
                          title="Radera mötet?"
                          description="Transkriptionen, anteckningarna och loggen här tas bort. Google-dokumentet ligger kvar i Drive."
                          confirmLabel="Radera mötet"
                          pendingLabel="Raderar…"
                        />
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="text-sm text-ink-3 border-t border-line px-6 pt-3 pb-4">
            Att radera ett möte tar bort transkription, anteckningar och logg här. Google-dokumentet ligger kvar.
            {viewerEmail && ` Mötesdokumenten delas till ${viewerEmail} – öppna dem i Google med den adressen.`}
          </p>
        </>
      )}
    </Panel>
  );
}

function PeoplePanel({
  orgId,
  people,
  isAdmin,
  actions,
}: {
  orgId: string;
  people: { id: string; name: string; role?: string | null }[];
  isAdmin: boolean;
  actions: OrgDetailViewProps["actions"];
}) {
  return (
    <Panel flush title="Personer" titleId="people-title" actions={<span className="text-sm text-ink-3">{people.length}</span>}>
      <p className="text-sm text-ink-3 -mt-2 px-6 pb-4">
        Alla som brukar vara med på mötena. Namnen används för att känna igen vem som talar. De behöver inget konto.
      </p>
      <form action={actions.addPerson} className="flex items-end gap-2 px-6 pb-4">
        <input type="hidden" name="orgId" value={orgId} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Label className="sr-only" htmlFor="new-person">
            Namn på ny person
          </Label>
          <Input id="new-person" name="name" placeholder="Namn, t.ex. Anna Berg" required maxLength={100} autoComplete="off" />
        </div>
        <SubmitButton icon={<IconPlus />} pendingLabel="Lägger till…">
          Lägg till
        </SubmitButton>
      </form>
      {people.length === 0 ? (
        <div className="px-6 pb-6">
          <EmptyState title="Inga personer än">
            <p>Lägg till de som brukar vara med. Det går också bra att låta namnrundan i första mötet fylla på listan.</p>
          </EmptyState>
        </div>
      ) : (
        <ul aria-labelledby="people-title">
          {people.map((person) => (
            <PersonRow
              key={person.id}
              orgId={orgId}
              person={person}
              renamePerson={actions.renamePerson}
              setPersonRole={isAdmin ? actions.setPersonRole : undefined}
              deletePerson={actions.deletePerson}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}
